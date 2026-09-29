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

export async function saveProfile(profile: Profile): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.serverUrl, profile.serverUrl);
  await AsyncStorage.setItem(STORAGE_KEYS.token, profile.token);
}

export async function clearProfile(): Promise<void> {
  await AsyncStorage.multiRemove([STORAGE_KEYS.serverUrl, STORAGE_KEYS.token]);
}
