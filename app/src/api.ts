import type * as Location from 'expo-location';
import { REQUEST_TIMEOUT_MS } from './config';

export type PersonLocation = {
  name: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  timestamp: number;
  updatedAt: number;
};

export type LocationsResponse = {
  you: PersonLocation | null;
  others: PersonLocation[];
};

export type LocationPayload = {
  lat: number;
  lng: number;
  accuracy: number | null;
  timestamp: number;
};

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

// The shape the server expects, built from what expo-location gives us.
export function locationToPayload(loc: Location.LocationObject): LocationPayload {
  return {
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    accuracy: loc.coords.accuracy,
    timestamp: loc.timestamp,
  };
}

async function request(serverUrl: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${normalizeUrl(serverUrl)}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    return res;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function postLocation(serverUrl: string, token: string, location: LocationPayload): Promise<void> {
  await request(serverUrl, token, '/api/location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(location),
  });
}

export async function fetchLocations(serverUrl: string, token: string): Promise<LocationsResponse> {
  const res = await request(serverUrl, token, '/api/locations');
  return res.json();
}
