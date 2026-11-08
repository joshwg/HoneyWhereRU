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
import { isSharing, startSharing, stopSharing } from './src/locationTask';
import { clearProfile, loadProfile, saveLastSentAt, saveProfile, type Profile } from './src/storage';
import { POLL_INTERVAL_MS, TOKEN_MAX_LEN, TOKEN_MIN_LEN } from './src/config';
import { PeopleMap, type MapPerson } from './src/PeopleMap';

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
  const [now, setNow] = useState(Date.now());
  // Android draws edge-to-edge, so the scroll content needs room for the
  // navigation bar or the last button sits underneath it.
  const insets = useSafeAreaInsets();
  // Polls can overlap (timer + "send now"); only the newest response wins so
  // a slow earlier reply can't overwrite fresher data.
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++latestRequest.current;
    try {
      const res = await fetchLocations(profile.serverUrl, profile.token);
      if (id !== latestRequest.current) return;
      setYou(res.you);
      setOthers([...res.others].sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (err) {
      console.warn('Failed to refresh locations:', err);
    }
  }, [profile]);

  useEffect(() => {
    let active = true;
    isSharing().then((v) => {
      if (active) setSharing(v);
    });
    refresh();

    const poll = setInterval(refresh, POLL_INTERVAL_MS);
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    // Timers are paused while the app is backgrounded, so refresh as soon as
    // it comes back rather than showing stale positions until the next tick.
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setNow(Date.now());
        refresh();
      }
    });
    return () => {
      active = false;
      latestRequest.current++; // drop any in-flight response
      clearInterval(poll);
      clearInterval(clock);
      appState.remove();
    };
  }, [refresh]);

  const toggleSharing = useCallback(async (value: boolean) => {
    setBusy(true);
    try {
      if (value) {
        if (!(await ensureForegroundPermission())) return;
        const bg = await Location.requestBackgroundPermissionsAsync();
        if (bg.status !== 'granted') {
          Alert.alert(
            'Background location needed',
            'To keep sharing while the app is closed, allow location access "Always" in Settings.'
          );
          return;
        }
        await startSharing();
        setSharing(true);
      } else {
        await stopSharing();
        setSharing(false);
      }
    } catch (err) {
      Alert.alert('Something went wrong', errorText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const sendNow = useCallback(async () => {
    setBusy(true);
    try {
      if (!(await ensureForegroundPermission())) return;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await postLocation(profile.serverUrl, profile.token, locationToPayload(loc));
      // Counts toward the 5-minute window, so the background task won't
      // follow a manual send with another post seconds later.
      await saveLastSentAt(Date.now());
      await refresh();
    } catch (err) {
      Alert.alert('Could not send location', errorText(err));
    } finally {
      setBusy(false);
    }
  }, [profile, refresh]);

  const mapPeople = useMemo<MapPerson[]>(() => {
    const list: MapPerson[] = others.map((p) => ({
      ...p,
      label: `${p.name} · ${formatRelativeTime(p.updatedAt, now)}${formatSpeedSuffix(p.speedMph)}`,
      isYou: false,
    }));
    if (you) list.push({ ...you, label: 'You', isYou: true });
    return list;
  }, [you, others, now]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Honey Where Are You?</Text>
        <PeopleMap people={mapPeople} baseUrl={profile.serverUrl} onPersonPress={openInMaps} />
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
          {sharing
            ? 'Sharing in the background, updating roughly every 5 minutes.'
            : 'Not sharing. Turn this on so everyone else can see your location.'}
        </Text>

        <Pressable style={styles.linkButton} onPress={sendNow} disabled={busy}>
          <Text style={styles.linkButtonText}>Send my location now</Text>
        </Pressable>

        <View style={styles.divider} />

        <Text style={styles.sectionTitle}>Everyone else</Text>
        {others.length > 0 ? (
          others.map((person) => (
            <PersonCard
              key={person.name}
              title={person.name}
              body={`Last seen ${formatRelativeTime(person.updatedAt, now)}${formatSpeedSuffix(person.speedMph)}`}
              spaced
              onPress={() => openInMaps(person.lat, person.lng)}
            />
          ))
        ) : (
          <Text style={styles.hint}>No locations from anyone else yet.</Text>
        )}

        <Text style={styles.sectionTitle}>You</Text>
        {you ? (
          <PersonCard
            title={`Last sent ${formatRelativeTime(you.updatedAt, now)}${formatSpeedSuffix(you.speedMph)}`}
            body={`${you.lat.toFixed(5)}, ${you.lng.toFixed(5)}${
              you.accuracy != null ? ` (±${Math.round(you.accuracy)} m)` : ''
            }`}
            onPress={() => openInMaps(you.lat, you.lng)}
          />
        ) : (
          <Text style={styles.hint}>You haven't sent a location yet.</Text>
        )}

        <Pressable style={styles.signOut} onPress={onEdit}>
          <Text style={styles.signOutText}>Change server URL or token</Text>
        </Pressable>
      </ScrollView>

      <StatusBar style="auto" />
    </View>
  );
}

function PersonCard({
  title,
  body,
  spaced,
  onPress,
}: {
  title: string;
  body: string;
  spaced?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.card, spaced && styles.cardSpaced]} onPress={onPress}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardBody}>{body}</Text>
      <Text style={styles.cardHint}>Tap to open in Maps</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
    padding: 16,
  },
  cardSpaced: {
    marginBottom: 10,
  },
  cardTitle: {
    fontSize: 16,
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
