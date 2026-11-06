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
  await AsyncStorage.multiRemove([STORAGE_KEYS.serverUrl, STORAGE_KEYS.token]);
}
