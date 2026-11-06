import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import * as Location from 'expo-location';

import { fetchLocations, postLocation, type PersonLocation } from './src/api';
import { formatRelativeTime } from './src/formatTime';
import { isSharing, startSharing, stopSharing } from './src/locationTask';
import { clearProfile, loadProfile, saveProfile, type Profile } from './src/storage';
import { POLL_INTERVAL_MS } from './src/config';
import { PeopleMap, type MapPerson } from './src/PeopleMap';

export default function App() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);

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

  return profile ? (
    <MainScreen profile={profile} onSignOut={() => setProfile(null)} />
  ) : (
    <SetupScreen onSaved={setProfile} />
  );
}

function SetupScreen({ onSaved }: { onSaved: (profile: Profile) => void }) {
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    if (!serverUrl.trim() || !token.trim()) {
      Alert.alert('Missing info', 'Enter both the server URL and your token.');
      return;
    }
    setSaving(true);
    try {
      const p = { serverUrl: serverUrl.trim(), token: token.trim() };
      // Sanity-check the token against the server before saving.
      await fetchLocations(p.serverUrl, p.token);
      await saveProfile(p);
      onSaved(p);
    } catch (err) {
      Alert.alert(
        'Could not connect',
        `Double-check the server URL and token.\n\n${(err as Error).message}`
      );
    } finally {
      setSaving(false);
    }
  }, [serverUrl, token, onSaved]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Honey Where Are You?</Text>
      <Text style={styles.subtitle}>Set up this phone</Text>

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
        secureTextEntry
        value={token}
        onChangeText={setToken}
      />

      <Pressable style={styles.button} onPress={save} disabled={saving}>
        {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Save</Text>}
      </Pressable>

      <StatusBar style="auto" />
    </View>
  );
}

function MainScreen({ profile, onSignOut }: { profile: Profile; onSignOut: () => void }) {
  const [sharing, setSharing] = useState(false);
  const [you, setYou] = useState<PersonLocation | null>(null);
  const [others, setOthers] = useState<PersonLocation[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetchLocations(profile.serverUrl, profile.token);
      setYou(res.you);
      setOthers([...res.others].sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (err) {
      console.warn('Failed to refresh locations:', err);
    }
  }, [profile]);

  useEffect(() => {
    isSharing().then(setSharing);
    refresh();

    pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      clearInterval(clock);
    };
  }, [refresh]);

  const toggleSharing = useCallback(
    async (value: boolean) => {
      setBusy(true);
      try {
        if (value) {
          const fg = await Location.requestForegroundPermissionsAsync();
          if (fg.status !== 'granted') {
            Alert.alert('Location permission needed', 'Enable location access to share your position.');
            return;
          }
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
        Alert.alert('Something went wrong', (err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const sendNow = useCallback(async () => {
    setBusy(true);
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        Alert.alert('Location permission needed', 'Enable location access to share your position.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await postLocation(profile.serverUrl, profile.token, {
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
        accuracy: loc.coords.accuracy,
        timestamp: loc.timestamp,
      });
      await refresh();
    } catch (err) {
      Alert.alert('Could not send location', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [profile, refresh]);

  const openInMaps = useCallback((loc: { lat: number; lng: number }) => {
    Linking.openURL(`https://www.google.com/maps?q=${loc.lat},${loc.lng}`);
  }, []);

  const mapPeople = useMemo<MapPerson[]>(() => {
    const list: MapPerson[] = others.map((p) => ({
      ...p,
      label: `${p.name} · ${formatRelativeTime(p.updatedAt, now)}`,
      isYou: false,
    }));
    if (you) list.push({ ...you, label: 'You', isYou: true });
    return list;
  }, [you, others, now]);

  const onMapPersonPress = useCallback(
    (lat: number, lng: number) => openInMaps({ lat, lng }),
    [openInMaps]
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Honey Where Are You?</Text>
        <PeopleMap people={mapPeople} baseUrl={profile.serverUrl} onPersonPress={onMapPersonPress} />
      </View>

      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
  
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
            <Pressable
              key={person.name}
              style={[styles.card, styles.cardSpaced]}
              onPress={() => openInMaps(person)}
            >
              <Text style={styles.cardTitle}>{person.name}</Text>
              <Text style={styles.cardBody}>Last seen {formatRelativeTime(person.updatedAt, now)}</Text>
              <Text style={styles.cardHint}>Tap to open in Maps</Text>
            </Pressable>
          ))
        ) : (
          <Text style={styles.hint}>No locations from anyone else yet.</Text>
        )}
  
        <Text style={styles.sectionTitle}>You</Text>
        {you ? (
          <Pressable style={styles.card} onPress={() => openInMaps(you)}>
            <Text style={styles.cardTitle}>Last sent {formatRelativeTime(you.updatedAt, now)}</Text>
            <Text style={styles.cardBody}>
              {you.lat.toFixed(5)}, {you.lng.toFixed(5)}
              {you.accuracy != null ? ` (±${Math.round(you.accuracy)} m)` : ''}
            </Text>
            <Text style={styles.cardHint}>Tap to open in Maps</Text>
          </Pressable>
        ) : (
          <Text style={styles.hint}>You haven't sent a location yet.</Text>
        )}
  
        <Pressable
          style={styles.signOut}
          onPress={() =>
            Alert.alert('Reset setup?', 'This clears the saved server URL and token on this phone.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Reset',
                style: 'destructive',
                onPress: async () => {
                  await stopSharing();
                  await clearProfile();
                  onSignOut();
                },
              },
            ])
          }
        >
          <Text style={styles.signOutText}>Reset setup</Text>
        </Pressable>
      </ScrollView>

      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
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
