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

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export async function postLocation(
  serverUrl: string,
  token: string,
  location: { lat: number; lng: number; accuracy: number | null; timestamp: number }
): Promise<void> {
  const res = await fetch(`${normalizeUrl(serverUrl)}/api/location`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(location),
  });
  if (!res.ok) {
    throw new Error(`Failed to post location (${res.status})`);
  }
}

export async function fetchLocations(serverUrl: string, token: string): Promise<LocationsResponse> {
  const res = await fetch(`${normalizeUrl(serverUrl)}/api/locations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch locations (${res.status})`);
  }
  return res.json();
}
