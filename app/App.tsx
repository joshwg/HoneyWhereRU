import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';

import { fetchLocations, locationToPayload, normalizeUrl, postLocation, type PersonLocation } from './src/api';
import { formatRelativeTime, formatSpeedSuffix } from './src/formatTime';
import {
  ensureSharingRunning,
  isSharing,
  startQuickUpdates,
  startSharing,
  stopQuickUpdates,
  stopSharing,
} from './src/locationTask';
import {
  clearProfile,
  EMPTY_BG_STATUS,
  loadBgStatus,
  loadProfile,
  loadQuickUntil,
  saveLastSent,
  saveProfile,
  type BgStatus,
  type Profile,
} from './src/storage';
import { POLL_INTERVAL_MS, QUICK_DEFAULT_MS, QUICK_POLL_INTERVAL_MS, QUICK_DURATIONS, TOKEN_MAX_LEN, TOKEN_MIN_LEN } from './src/config';
import { mapId, PeopleMap, type MapPerson, type PeopleMapHandle } from './src/PeopleMap';

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    loadProfile()
      .then(setProfile)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <StatusBar style="auto" />
      </View>
    );
  }

  if (!profile || editing) {
    return (
      <SetupScreen
        initial={profile}
        onSaved={(p) => {
          setProfile(p);
          setEditing(false);
        }}
        onCancel={profile ? () => setEditing(false) : undefined}
        onForget={
          profile
            ? () => {
                setProfile(null);
                setEditing(false);
              }
            : undefined
        }
      />
    );
  }

  return <MainScreen profile={profile} onEdit={() => setEditing(true)} />;
}

// Shared by the "share" toggle and "send now": both need foreground location
// before they can do anything.
async function ensureForegroundPermission(): Promise<boolean> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status === 'granted') return true;
  Alert.alert('Location permission needed', 'Enable location access to share your position.');
  return false;
}

// Turning sharing on (the switch or a quick update) needs foreground and then
// background ("Always") location.
async function ensureSharingPermissions(): Promise<boolean> {
  if (!(await ensureForegroundPermission())) return false;
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status === 'granted') return true;
  Alert.alert(
    'Background location needed',
    'To keep sharing while the app is closed, allow location access "Always" in Settings.'
  );
  return false;
}

// Marks a person on quick updates, on the map and their card.
const QUICK_MARK = '⚡';

// How long the "✓ Sent" / "✗ Not sent" badge stays after "Send my location now" succeeds.
const SENT_CONFIRM_MS = 12 * 1000;

// "3:45 PM", without leaning on Intl (not every Hermes build has full locale data).
function formatClock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Whatever was thrown, produce something readable for an alert: an Error's
// message, or the raw value if it wasn't an Error (or had no message).
function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const s = String(err);
  return s && s !== '[object Object]' ? s : 'No details were given.';
}

function openInMaps(lat: number, lng: number) {
  Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`);
}

// First-run setup, and also the "change server URL or token" screen: when
// `initial` is given the fields are pre-filled and Cancel/Forget are offered.
function SetupScreen({
  initial,
  onSaved,
  onCancel,
  onForget,
}: {
  initial: Profile | null;
  onSaved: (profile: Profile) => void;
  onCancel?: () => void;
  onForget?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? '');
  const [token, setToken] = useState(initial?.token ?? '');
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    const p: Profile = { serverUrl: normalizeUrl(serverUrl), token: token.trim() };
    if (!p.serverUrl || !p.token) {
      Alert.alert('Missing info', 'Enter both the server URL and your token.');
      return;
    }
    // A bare host like "whereru.example.com" (no scheme at all) gets https://
    // added; anything with a scheme (e.g. http://) is left to fail the check below.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(p.serverUrl) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(p.serverUrl)) {
      p.serverUrl = `https://${p.serverUrl}`;
      setServerUrl(p.serverUrl);
    }
    if (!/^https:\/\//i.test(p.serverUrl)) {
      Alert.alert('Check the server URL', 'The server URL must start with https://');
      return;
    }
    if (p.token.length < TOKEN_MIN_LEN || p.token.length > TOKEN_MAX_LEN) {
      Alert.alert(
        'Check your token',
        `Tokens are ${TOKEN_MIN_LEN} to ${TOKEN_MAX_LEN} characters. You entered ${p.token.length}.`
      );
      return;
    }
    setSaving(true);
    try {
      // Sanity-check the token against the server before saving.
      await fetchLocations(p.serverUrl, p.token);
      // Sharing keeps running across a settings change: the background task
      // reads the saved profile fresh on every update.
      await saveProfile(p);
      onSaved(p);
    } catch (err) {
      Alert.alert('Could not connect', `Double-check the server URL and token.\n\n${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  }, [serverUrl, token, onSaved]);

  const forget = useCallback(() => {
    Alert.alert('Forget this phone?', 'This stops sharing and clears the saved server URL and token.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: async () => {
          try {
            await stopSharing();
            await clearProfile();
            onForget?.();
          } catch (err) {
            Alert.alert('Could not reset', errorText(err));
          }
        },
      },
    ]);
  }, [onForget]);

  return (
    <View style={[styles.container, styles.setup, { paddingBottom: insets.bottom }]}>
      <Text style={styles.title}>Honey Where Are You?</Text>
      <Text style={styles.subtitle}>{initial ? 'Change server or token' : 'Set up this phone'}</Text>

      <Text style={styles.label}>Server URL</Text>
      <TextInput
        style={styles.input}
        placeholder="https://whereru.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={serverUrl}
        onChangeText={setServerUrl}
      />

      <Text style={styles.label}>Your access token</Text>
      <TextInput
        style={styles.input}
        placeholder="the token your server assigned you"
        autoCapitalize="none"
        autoCorrect={false}
        value={token}
        onChangeText={setToken}
      />

      <Pressable style={styles.button} onPress={save} disabled={saving}>
        {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Save</Text>}
      </Pressable>

      {onCancel && (
        <Pressable style={styles.linkButton} onPress={onCancel} disabled={saving}>
          <Text style={styles.linkButtonText}>Cancel</Text>
        </Pressable>
      )}

      {onForget && (
        <Pressable style={styles.signOut} onPress={forget} disabled={saving}>
          <Text style={styles.signOutText}>Forget this phone</Text>
        </Pressable>
      )}

      <StatusBar style="auto" />
    </View>
  );
}

function MainScreen({ profile, onEdit }: { profile: Profile; onEdit: () => void }) {
  const [sharing, setSharing] = useState(false);
  const [you, setYou] = useState<PersonLocation | null>(null);
  const [others, setOthers] = useState<PersonLocation[]>([]);
  const [busy, setBusy] = useState(false);
  // Feedback next to "Send my location now": a spinner while it's working,
  // then a green tick or red cross that clears itself after SENT_CONFIRM_MS.
  const [sendStatus, setSendStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (sentTimer.current) clearTimeout(sentTimer.current);
  }, []);
  const [now, setNow] = useState(Date.now());
  // When quick updates end (ms since epoch), 0 if off. The background side
  // ends them on its own once the time passes, so this is re-read from
  // storage on every clock tick rather than trusted.
  const [quickUntil, setQuickUntil] = useState(0);
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  // What the background side last did, shown under "You" so a phone that
  // has stopped updating says why.
  const [bg, setBg] = useState<BgStatus>(EMPTY_BG_STATUS);
  // Android draws edge-to-edge, so the scroll content needs room for the
  // navigation bar or the last button sits underneath it.
  const insets = useSafeAreaInsets();
  // Polls can overlap (timer + "send now"); only the newest response wins so
  // a slow earlier reply can't overwrite fresher data.
  const latestRequest = useRef(0);
  // Tapping a card centres the map above on that person.
  const mapRef = useRef<PeopleMapHandle>(null);
  const focusOnMap = useCallback((p: { name: string; isYou: boolean }) => mapRef.current?.focus(mapId(p)), []);

  const refresh = useCallback(async () => {
    const id = ++latestRequest.current;
    try {
      const res = await fetchLocations(profile.serverUrl, profile.token);
      if (id !== latestRequest.current) return;
      setNow(Date.now()); // keep "last seen" labels in step with fast polls
      setYou(res.you);
      setOthers([...res.others].sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (err) {
      console.warn('Failed to refresh locations:', err);
    }
  }, [profile]);

  useEffect(() => {
    let active = true;
    const syncState = () => {
      isSharing().then((v) => {
        if (active) setSharing(v);
      });
      loadQuickUntil().then((v) => {
        if (active) setQuickUntil(v);
      });
      loadBgStatus().then((v) => {
        if (active) setBg(v);
      });
    };
    // Restart background updates in case the OS stopped them while the app
    // was away (see ensureSharingRunning).
    // It can also turn sharing back on, so the switch is re-read after.
    const heal = () => {
      ensureSharingRunning()
        .catch((err) => console.warn('Could not restart location updates:', err))
        .finally(syncState);
    };
    heal();
    syncState();
    refresh();

    const clock = setInterval(() => {
      setNow(Date.now());
      syncState();
    }, 15_000);
    // Timers are paused while the app is backgrounded, so refresh as soon as
    // it comes back rather than showing stale positions until the next tick.
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        heal();
        setNow(Date.now());
        syncState();
        refresh();
      }
    });
    return () => {
      active = false;
      latestRequest.current++; // drop any in-flight response
      clearInterval(clock);
      appState.remove();
    };
  }, [refresh]);

  const toggleSharing = useCallback(async (value: boolean) => {
    setBusy(true);
    try {
      if (value) {
        if (!(await ensureSharingPermissions())) return;
        await startSharing();
        setSharing(true);
      } else {
        // Also ends quick updates.
        await stopSharing();
        setSharing(false);
        setQuickUntil(0);
      }
    } catch (err) {
      Alert.alert('Something went wrong', errorText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const startQuick = useCallback(async (durationMs: number) => {
    setQuickMenuOpen(false);
    setBusy(true);
    try {
      if (!(await ensureSharingPermissions())) return;
      const until = await startQuickUpdates(durationMs);
      setSharing(true);
      setQuickUntil(until);
      setNow(Date.now());
    } catch (err) {
      Alert.alert('Could not start quick updates', errorText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const stopQuick = useCallback(async () => {
    setBusy(true);
    try {
      await stopQuickUpdates();
      setQuickUntil(0);
    } catch (err) {
      Alert.alert('Could not stop quick updates', errorText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const quickOn = sharing && quickUntil > now;

  // Poll every 5 seconds while anyone (this phone included) is on quick
  // updates, otherwise once a minute. The initial fetch happens above.
  const fastPoll = quickOn || !!you?.quick || others.some((p) => p.quick);
  useEffect(() => {
    const poll = setInterval(refresh, fastPoll ? QUICK_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
    return () => clearInterval(poll);
  }, [refresh, fastPoll]);

  const sendNow = useCallback(async () => {
    setBusy(true);
    if (sentTimer.current) clearTimeout(sentTimer.current);
    setSendStatus('sending');
    let sent = false;
    try {
      if (!(await ensureForegroundPermission())) return;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const payload = locationToPayload(loc, (await loadQuickUntil()) > Date.now());
      await postLocation(profile.serverUrl, profile.token, payload);
      // Counts toward the 5-minute window, so the background task won't
      // follow a manual send with another post seconds later.
      await saveLastSent(Date.now(), payload);
      sent = true;
      // Confirm as soon as the post lands; the refresh below can be slow.
      setSendStatus('sent');
      sentTimer.current = setTimeout(() => setSendStatus('idle'), SENT_CONFIRM_MS);
      await refresh();
    } catch (err) {
      // A failed refresh after a successful post is still "sent"; refresh()
      // swallows its own errors, so anything here is a failed send.
      Alert.alert('Could not send location', errorText(err));
    } finally {
      // Also covers a refused permission (its own alert has already shown).
      if (!sent) {
        setSendStatus('failed');
        sentTimer.current = setTimeout(() => setSendStatus('idle'), SENT_CONFIRM_MS);
      }
      setBusy(false);
    }
  }, [profile, refresh]);

  const mapPeople = useMemo<MapPerson[]>(() => {
    const list: MapPerson[] = others.map((p) => ({
      ...p,
      label: `${p.quick ? `${QUICK_MARK} ` : ''}${p.name} · ${formatRelativeTime(p.updatedAt, now)}${formatSpeedSuffix(p.speedMph)}`,
      isYou: false,
    }));
    if (you) list.push({ ...you, label: you.quick ? `${QUICK_MARK} You` : 'You', isYou: true });
    return list;
  }, [you, others, now]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Honey Where Are You?</Text>
        <PeopleMap ref={mapRef} people={mapPeople} baseUrl={profile.serverUrl} />
        <Pressable style={styles.showEveryone} onPress={() => mapRef.current?.showEveryone()}>
          <Text style={styles.linkButtonText}>Show everyone</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: styles.scrollContent.paddingBottom + insets.bottom }]}
      >
        <View style={styles.row}>
          <Text style={styles.label}>Share my location</Text>
          <Switch value={sharing} onValueChange={toggleSharing} disabled={busy} />
        </View>
        <Text style={styles.hint}>
          {quickOn
            ? `Quick updates until ${formatClock(quickUntil)}: sending whenever you move (at most every 5 seconds, at least every 20).`
            : sharing
              ? 'Sharing in the background, updating every 5 minutes (even when you stay put).'
              : 'Not sharing. Turn this on so everyone else can see your location.'}
        </Text>

        <View style={styles.quickRow}>
          {/* Split button: the label starts (or restarts) the 30-minute
              default, the arrow opens the other durations. */}
          <View style={[styles.quickButton, quickOn && styles.quickButtonOn]}>
            <Pressable style={styles.quickButtonMain} onPress={() => startQuick(QUICK_DEFAULT_MS)} disabled={busy}>
              <Text style={[styles.quickButtonText, quickOn && styles.quickButtonTextOn]}>
                {quickOn ? `Quick update · until ${formatClock(quickUntil)}` : 'Quick update · 30 min'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.quickButtonArrow, quickOn && styles.quickButtonArrowOn]}
              onPress={() => setQuickMenuOpen((open) => !open)}
              disabled={busy}
              accessibilityLabel="Choose how long quick updates run"
            >
              <Text style={[styles.quickButtonText, quickOn && styles.quickButtonTextOn]}>
                {quickMenuOpen ? '▴' : '▾'}
              </Text>
            </Pressable>
          </View>
          {quickOn && (
            <Pressable style={styles.quickStop} onPress={stopQuick} disabled={busy}>
              <Text style={styles.linkButtonText}>Stop</Text>
            </Pressable>
          )}
        </View>
        {quickMenuOpen && (
          <View style={styles.quickMenu}>
            {QUICK_DURATIONS.map((d) => (
              <Pressable key={d.ms} style={styles.quickMenuItem} onPress={() => startQuick(d.ms)} disabled={busy}>
                <Text style={styles.quickMenuText}>
                  {d.label}
                  {d.ms === QUICK_DEFAULT_MS ? ' (default)' : ''}
                  <Text style={styles.quickMenuHint}>  until {formatClock(now + d.ms)}</Text>
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.sendRow}>
          <Pressable onPress={sendNow} disabled={busy}>
            <Text style={styles.linkButtonText}>Send my location now</Text>
          </Pressable>
          {sendStatus === 'sending' && (
            <View style={styles.sendStatus}>
              <ActivityIndicator size="small" />
              <Text style={styles.sendingText}>Sending…</Text>
            </View>
          )}
          {sendStatus === 'sent' && (
            <View style={[styles.sendStatus, styles.sentBadge]}>
              <Text style={styles.sentText}>✓ Sent</Text>
            </View>
          )}
          {sendStatus === 'failed' && (
            <View style={[styles.sendStatus, styles.failedBadge]}>
              <Text style={styles.failedText}>✗ Not sent</Text>
            </View>
          )}
        </View>

        <View style={styles.divider} />

        <Text style={styles.sectionTitle}>Everyone else</Text>
        {others.length > 0 ? (
          others.map((person) => (
            <PersonCard
              key={person.name}
              title={person.name}
              quick={person.quick}
              body={`Last seen ${formatRelativeTime(person.updatedAt, now)}${formatSpeedSuffix(person.speedMph)}`}
              spaced
              onPress={() => focusOnMap({ name: person.name, isYou: false })}
              onOpenMaps={() => openInMaps(person.lat, person.lng)}
            />
          ))
        ) : (
          <Text style={styles.hint}>No locations from anyone else yet.</Text>
        )}

        <Text style={styles.sectionTitle}>You</Text>
        {you ? (
          <PersonCard
            title={`Last sent ${formatRelativeTime(you.updatedAt, now)}${formatSpeedSuffix(you.speedMph)}`}
            quick={you.quick}
            body={`${you.lat.toFixed(5)}, ${you.lng.toFixed(5)}${
              you.accuracy != null ? ` (±${Math.round(you.accuracy)} m)` : ''
            }`}
            onPress={() => focusOnMap({ name: you.name, isYou: true })}
            onOpenMaps={() => openInMaps(you.lat, you.lng)}
          />
        ) : (
          <Text style={styles.hint}>You haven't sent a location yet.</Text>
        )}
        {sharing && <BgStatusLines status={bg} now={now} />}

        <Pressable style={styles.signOut} onPress={onEdit}>
          <Text style={styles.signOutText}>Change server URL or token</Text>
        </Pressable>
      </ScrollView>

      <StatusBar style="auto" />
    </View>
  );
}

// A few plain lines about the background sender on this phone, for working
// out why updates stopped: whether it's still trying, whether the OS is still
// delivering locations, and whether the app has been restarted.
function BgStatusLines({ status: s, now }: { status: BgStatus; now: number }) {
  const lines: { text: string; bad?: boolean }[] = [];
  lines.push(
    s.attemptAt
      ? { text: `Last background send ${formatRelativeTime(s.attemptAt, now)}: ${s.ok ? 'OK' : 'failed'}`, bad: !s.ok }
      : { text: 'No background send yet' }
  );
  // Show the last error while sends are failing, and for a day after.
  if (s.error && (!s.ok || now - s.errorAt < 24 * 60 * 60 * 1000)) {
    lines.push({ text: `Last error (${formatRelativeTime(s.errorAt, now)}): ${s.error}`, bad: !s.ok });
  }
  lines.push({ text: `Last location from the phone: ${s.fixAt ? formatRelativeTime(s.fixAt, now) : 'none yet'}` });
  if (s.startedAt) lines.push({ text: `App (re)started ${formatRelativeTime(s.startedAt, now)}` });
  if (s.unstuckCount) {
    lines.push({
      text: `Recovered from a stuck send ${s.unstuckCount} time${s.unstuckCount === 1 ? '' : 's'} (last ${formatRelativeTime(s.unstuckAt, now)})`,
      bad: true,
    });
  }
  return (
    <View style={styles.bgStatus}>
      {lines.map((l) => (
        <Text key={l.text} style={[styles.bgStatusText, l.bad && styles.bgStatusBad]}>
          {l.text}
        </Text>
      ))}
    </View>
  );
}

function PersonCard({
  title,
  body,
  quick,
  spaced,
  onPress,
  onOpenMaps,
}: {
  title: string;
  body: string;
  quick?: boolean;
  spaced?: boolean;
  onPress: () => void; // show them on the map above
  onOpenMaps: () => void; // hand off to the phone's maps app
}) {
  return (
    <View style={[styles.card, spaced && styles.cardSpaced]}>
      <Pressable style={styles.cardMain} onPress={onPress}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>{title}</Text>
          {quick && (
            <View style={styles.quickBadge}>
              <Text style={styles.quickBadgeText}>{QUICK_MARK} Quick updates</Text>
            </View>
          )}
        </View>
        <Text style={styles.cardBody}>{body}</Text>
        <Text style={styles.cardHint}>Tap to show on the map</Text>
      </Pressable>
      <Pressable style={styles.mapsButton} onPress={onOpenMaps} hitSlop={8} accessibilityLabel="Open in Maps">
        <Text style={styles.mapsButtonIcon}>🗺️</Text>
        <Text style={styles.mapsButtonText}>Maps</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bgStatus: {
    marginTop: 10,
  },
  bgStatusText: {
    fontSize: 12,
    color: '#888',
    lineHeight: 17,
  },
  bgStatusBad: {
    color: '#b3261e',
  },
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  setup: {
    paddingTop: 56,
    paddingHorizontal: 24,
  },
  header: {
    paddingTop: 56,
    paddingHorizontal: 24,
  },
  scrollContent: {
    paddingTop: 8,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginTop: 16,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: {
    marginTop: 28,
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  hint: {
    color: '#666',
    fontSize: 13,
    marginTop: 6,
  },
  linkButton: {
    marginTop: 16,
    alignSelf: 'flex-start',
  },
  linkButtonText: {
    color: '#2563eb',
    fontSize: 14,
    fontWeight: '600',
  },
  sendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    minHeight: 28,
  },
  sendStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 12,
  },
  sendingText: {
    marginLeft: 6,
    color: '#666',
    fontSize: 13,
  },
  sentBadge: {
    backgroundColor: '#dcfce7',
    borderRadius: 12,
    paddingVertical: 3,
    paddingHorizontal: 10,
  },
  sentText: {
    color: '#15803d',
    fontSize: 13,
    fontWeight: '700',
  },
  failedBadge: {
    backgroundColor: '#fee2e2',
    borderRadius: 12,
    paddingVertical: 3,
    paddingHorizontal: 10,
  },
  failedText: {
    color: '#b91c1c',
    fontSize: 13,
    fontWeight: '700',
  },
  quickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
  },
  quickButton: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#2563eb',
    borderRadius: 8,
  },
  quickButtonMain: {
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 10,
  },
  quickButtonArrow: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderLeftWidth: 1,
    borderLeftColor: '#2563eb',
  },
  quickButtonArrowOn: {
    borderLeftColor: '#fff',
  },
  quickButtonOn: {
    backgroundColor: '#2563eb',
  },
  quickButtonText: {
    color: '#2563eb',
    fontSize: 14,
    fontWeight: '600',
  },
  quickButtonTextOn: {
    color: '#fff',
  },
  quickStop: {
    marginLeft: 16,
  },
  quickMenu: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    alignSelf: 'flex-start',
    minWidth: 220,
    backgroundColor: '#fff',
  },
  quickMenuItem: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  quickMenuText: {
    fontSize: 15,
    color: '#222',
  },
  quickMenuHint: {
    fontSize: 13,
    color: '#888',
  },
  divider: {
    height: 1,
    backgroundColor: '#eee',
    marginVertical: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 16,
  },
  card: {
    backgroundColor: '#f5f7fb',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardMain: {
    flex: 1,
    padding: 16,
  },
  mapsButton: {
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  mapsButtonIcon: {
    fontSize: 20,
  },
  mapsButtonText: {
    fontSize: 11,
    color: '#2563eb',
    fontWeight: '600',
    marginTop: 2,
  },
  showEveryone: {
    alignSelf: 'flex-end',
    paddingVertical: 8,
  },
  cardSpaced: {
    marginBottom: 10,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  quickBadge: {
    marginLeft: 8,
    backgroundColor: '#fef3c7',
    borderRadius: 10,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  quickBadgeText: {
    color: '#b45309',
    fontSize: 12,
    fontWeight: '700',
  },
  cardBody: {
    fontSize: 14,
    color: '#444',
    marginTop: 4,
  },
  cardHint: {
    fontSize: 12,
    color: '#2563eb',
    marginTop: 8,
  },
  signOut: {
    marginTop: 40,
    alignItems: 'center',
  },
  signOutText: {
    color: '#999',
    fontSize: 13,
  },
});
