import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import type { PersonLocation } from './api';

export type MapPerson = PersonLocation & { label: string; isYou: boolean };

// Leaflet + OpenStreetMap tiles inside a WebView: no API key needed. The page
// exposes window.setPeople(); markers post a message back when tapped.
//
// The Leaflet tags carry Subresource Integrity hashes (sha384 of the 1.9.4
// dist files) so a tampered CDN response is refused rather than executed.
// Bump the version and hashes together if you upgrade Leaflet.
const MAP_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      integrity="sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H" crossorigin="anonymous" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
        integrity="sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH" crossorigin="anonymous"></script>
<style>
  html, body, #map { margin: 0; height: 100%; width: 100%; }
  .fit { background: #fff; width: 30px; height: 30px; line-height: 30px; text-align: center;
         font: 18px sans-serif; cursor: pointer; }
</style>
</head>
<body>
<div id="map"></div>
<script>
  function post(msg) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }

  // Leaflet tooltips take HTML, so names from the server are escaped before
  // they're rendered.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var map = L.map('map', { zoomControl: true }).setView([39.5, -98.35], 3);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  map.attributionControl.setPrefix(false);

  // Links (the attribution) open in the system browser, not inside the map.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (a && a.href) { e.preventDefault(); post({ type: 'open', url: a.href }); }
  });

  var layer = L.layerGroup().addTo(map);
  var bounds = null;
  var fitted = false;
  // With exactly one other person the map follows them: the "lat,lng" we
  // last centred on, so a redraw that didn't move them doesn't touch the view.
  var followed = null;

  function fitAll() {
    if (!bounds) return;
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      map.setView(bounds.getCenter(), 15);
    } else {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
  }

  var FitControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      var div = L.DomUtil.create('div', 'leaflet-bar fit');
      div.innerHTML = '&#8982;';
      div.title = 'Show everyone';
      L.DomEvent.on(div, 'click', function (e) { L.DomEvent.stop(e); fitAll(); });
      return div;
    }
  });
  map.addControl(new FitControl());

  window.setPeople = function (people) {
    layer.clearLayers();
    bounds = null;
    people.forEach(function (p) {
      var color = p.isYou ? '#2563eb' : '#ea580c';
      var ll = [p.lat, p.lng];
      if (p.accuracy) {
        L.circle(ll, { radius: p.accuracy, color: color, weight: 1, fillOpacity: 0.1, interactive: false }).addTo(layer);
      }
      L.circleMarker(ll, { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(escapeHtml(p.label), { permanent: true, direction: 'top', offset: [0, -8] })
        .on('click', function () { post({ type: 'person', lat: p.lat, lng: p.lng }); })
        .addTo(layer);
      bounds = bounds ? bounds.extend(ll) : L.latLngBounds(ll, ll);
    });
    var others = people.filter(function (p) { return !p.isYou; });
    if (others.length === 1) {
      // Two-person mode: keep the other person centred. Re-centre whenever
      // their position changes; keep whatever zoom the user has chosen.
      var o = others[0];
      var key = o.lat + ',' + o.lng;
      if (key !== followed) {
        followed = key;
        map.setView([o.lat, o.lng], fitted ? map.getZoom() : 15);
        fitted = true;
      }
      return;
    }
    followed = null;
    // Group mode: only auto-frame once, so a background refresh doesn't yank
    // the view away from wherever the user has panned to.
    if (!fitted && bounds) { fitAll(); fitted = true; }
  };

  post({ type: 'ready' });
</script>
</body>
</html>`;

// The WebView can ask the app to open a link; only ordinary web URLs are
// honoured so page content can't trigger tel:, sms:, or other app schemes.
function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function PeopleMap({
  people,
  baseUrl,
  onPersonPress,
}: {
  people: MapPerson[];
  // Pages load with this origin so OSM's tile servers see a real Referer.
  baseUrl: string;
  onPersonPress: (lat: number, lng: number) => void;
}) {
  const webRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const payload = people.map(({ name, label, lat, lng, accuracy, isYou }) => ({
      name,
      label,
      lat,
      lng,
      accuracy,
      isYou,
    }));
    webRef.current?.injectJavaScript(`window.setPeople(${JSON.stringify(payload)}); true;`);
  }, [ready, people]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: { type: string; url?: string; lat?: number; lng?: number };
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.type === 'ready') setReady(true);
      else if (msg.type === 'open' && msg.url && isWebUrl(msg.url)) Linking.openURL(msg.url);
      else if (msg.type === 'person' && typeof msg.lat === 'number' && typeof msg.lng === 'number')
        onPersonPress(msg.lat, msg.lng);
    },
    [onPersonPress]
  );

  return (
    <View style={styles.wrap}>
      <WebView
        ref={webRef}
        source={{ html: MAP_HTML, baseUrl }}
        onMessage={onMessage}
        // A reload (e.g. the WebView process restarting) re-sends 'ready'.
        onLoadStart={() => setReady(false)}
        style={styles.web}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: 320,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#e5e7eb',
  },
  web: {
    flex: 1,
  },
});
