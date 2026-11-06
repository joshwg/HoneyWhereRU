export const LOCATION_TASK_NAME = 'whereru-background-location-task';

// How often we ask the OS to wake us up and report a location.
// Exact on Android; best-effort on iOS (see README for why).
export const UPDATE_INTERVAL_MS = 5 * 60 * 1000;

// Hard floor between two location posts from this phone, whether from the
// background task or the "Send my location now" button. Android already
// spaces fixes by UPDATE_INTERVAL_MS at the OS level; iOS ignores that
// setting and can deliver a location every few seconds, so the app enforces
// the cadence itself. The 2-second allowance only absorbs timing jitter
// between the OS timer and when the task actually runs, so an Android fix
// arriving at 4:59.8 isn't dropped and pushed out to the 10-minute mark.
export const MIN_SEND_GAP_MS = UPDATE_INTERVAL_MS - 2 * 1000;

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
  // When the background task last posted successfully (ms since epoch).
  lastSentAt: 'whereru:lastSentAt',
} as const;
