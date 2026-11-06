export const LOCATION_TASK_NAME = 'whereru-background-location-task';

// How often we ask the OS to wake us up and report a location.
// Exact on Android; best-effort on iOS (see README for why).
export const UPDATE_INTERVAL_MS = 5 * 60 * 1000;

// How often the foregrounded app re-checks everyone else's last known spot.
export const POLL_INTERVAL_MS = 60 * 1000;

// Give up on a server request after this long. Matters most in the
// background task, where a hung request would otherwise keep the task alive
// until the OS kills it.
export const REQUEST_TIMEOUT_MS = 15 * 1000;

// Must match minTokenLen / maxTokenLen in server/main.go.
export const TOKEN_MIN_LEN = 12;
export const TOKEN_MAX_LEN = 48;

export const STORAGE_KEYS = {
  serverUrl: 'whereru:serverUrl',
  token: 'whereru:token',
} as const;
