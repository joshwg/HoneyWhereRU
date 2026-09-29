export const LOCATION_TASK_NAME = 'whereru-background-location-task';

// How often we ask the OS to wake us up and report a location.
// Exact on Android; best-effort on iOS (see README for why).
export const UPDATE_INTERVAL_MS = 5 * 60 * 1000;

// How often the foregrounded app re-checks everyone else's last known spot.
export const POLL_INTERVAL_MS = 60 * 1000;

export const STORAGE_KEYS = {
  serverUrl: 'whereru:serverUrl',
  token: 'whereru:token',
} as const;
