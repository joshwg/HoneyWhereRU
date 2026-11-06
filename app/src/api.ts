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
// iOS reports a negative accuracy when it doesn't trust the fix yet; send
// that as "unknown" rather than a value the server would reject.
export function locationToPayload(loc: Location.LocationObject): LocationPayload {
  const acc = loc.coords.accuracy;
  return {
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    accuracy: acc != null && Number.isFinite(acc) && acc >= 0 ? acc : null,
    // iOS gives fractional milliseconds; the server stores whole ones.
    timestamp: Math.round(loc.timestamp),
  };
}

// Turn an HTTP failure into a message a person can act on, using the
// server's own {"error": "..."} body when it sent one.
async function describeFailure(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') detail = body.error;
  } catch {
    // not JSON (e.g. an Apache error page) -- fall through to the status
  }
  switch (res.status) {
    case 401:
      return `The server rejected your token (401). Check it under "Change server URL or token".${detail ? `\n\n${detail}` : ''}`;
    case 404:
      return 'The server URL is wrong (404) -- it does not look like a Whereru server.';
    case 502:
    case 503:
      return `The server is not running behind that URL (${res.status}).`;
    default:
      return `Server returned ${res.status}${detail ? `: ${detail}` : ''}`;
  }
}

async function request(serverUrl: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${normalizeUrl(serverUrl)}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`No reply from the server after ${REQUEST_TIMEOUT_MS / 1000}s. Check your connection.`);
      }
      // React Native's fetch only says "Network request failed" -- add the usual causes.
      throw new Error(
        `Could not reach the server (${(err as Error).message}). Check your connection, that the URL starts with https://, and that the server is up.`
      );
    }
    if (!res.ok) {
      throw new Error(await describeFailure(res));
    }
    return res;
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
