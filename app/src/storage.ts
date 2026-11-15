import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './config';

export type Profile = {
  serverUrl: string;
  token: string;
};

export async function loadProfile(): Promise<Profile | null> {
  const [serverUrl, token] = await Promise.all([
    AsyncStorage.getItem(STORAGE_KEYS.serverUrl),
    AsyncStorage.getItem(STORAGE_KEYS.token),
  ]);
  if (!serverUrl || !token) return null;
  return { serverUrl, token };
}

// multiSet writes both keys in one operation so a crash mid-save can't leave
// a URL paired with the wrong token.
export async function saveProfile(profile: Profile): Promise<void> {
  await AsyncStorage.multiSet([
    [STORAGE_KEYS.serverUrl, profile.serverUrl],
    [STORAGE_KEYS.token, profile.token],
  ]);
}

export async function clearProfile(): Promise<void> {
  await AsyncStorage.multiRemove([
    STORAGE_KEYS.serverUrl,
    STORAGE_KEYS.token,
    STORAGE_KEYS.lastSentAt,
    STORAGE_KEYS.lastSentPos,
    STORAGE_KEYS.quickUntil,
  ]);
}

export type LastSent = {
  at: number; // ms since epoch, 0 if never
  pos: { lat: number; lng: number } | null;
};

function parseMs(raw: string | null): number {
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function loadLastSent(): Promise<LastSent> {
  const [[, at], [, pos]] = await AsyncStorage.multiGet([STORAGE_KEYS.lastSentAt, STORAGE_KEYS.lastSentPos]);
  let parsed: LastSent['pos'] = null;
  try {
    const p = pos ? JSON.parse(pos) : null;
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) parsed = { lat: p.lat, lng: p.lng };
  } catch {
    // corrupt value: treat as unknown, the next post rewrites it
  }
  return { at: parseMs(at), pos: parsed };
}

// When a post succeeded and where it said we were.
export async function saveLastSent(ms: number, pos: { lat: number; lng: number }): Promise<void> {
  await AsyncStorage.multiSet([
    [STORAGE_KEYS.lastSentAt, String(ms)],
    [STORAGE_KEYS.lastSentPos, JSON.stringify({ lat: pos.lat, lng: pos.lng })],
  ]);
}

// 0 when quick updates are off.
export async function loadQuickUntil(): Promise<number> {
  return parseMs(await AsyncStorage.getItem(STORAGE_KEYS.quickUntil));
}

export async function saveQuickUntil(ms: number): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.quickUntil, String(ms));
}

export async function clearQuickUntil(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEYS.quickUntil);
}
