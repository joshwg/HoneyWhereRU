export const LOCATION_TASK_NAME = 'whereru-background-location-task';

// How often we ask the OS to wake us up and report a location.
// Exact on Android; best-effort on iOS (see README for why).
export const UPDATE_INTERVAL_MS = 5 * 60 * 1000;

// Hard floor between two location posts from this phone in normal mode,
// whether from the background task or the "Send my location now" button. Android already
// spaces fixes by UPDATE_INTERVAL_MS at the OS level; iOS ignores that
// setting and can deliver a location every few seconds, so the app enforces
// the cadence itself. The 2-second allowance only absorbs timing jitter
// between the OS timer and when the task actually runs, so an Android fix
// arriving at 4:59.8 isn't dropped and pushed out to the 10-minute mark.
export const MIN_SEND_GAP_MS = UPDATE_INTERVAL_MS - 2 * 1000;

// If nothing has been posted for this long while sharing, the app fetches a
// position itself and posts it, even if the OS hasn't delivered one (iOS
// often stops delivering when the phone sits still). The point is an
// "is alive" signal every ~5 minutes. The extra 15 seconds lets Android's
// own 5-minute fix win the race normally, so this only kicks in when the OS
// has gone quiet.
export const HEARTBEAT_GAP_MS = UPDATE_INTERVAL_MS + 15 * 1000;

// How often the app checks whether a heartbeat (above, or the quick-update
// ceiling below) is due.
export const HEARTBEAT_TICK_MS = 5 * 1000;

// Quick updates: for a chosen while, post whenever the phone has moved, but
// never more often than QUICK_MIN_GAP_MS, and at least every QUICK_MAX_GAP_MS
// even when standing still. The ceiling is set a little under 20 seconds so
// the post (a fix lookup plus a network round trip) lands inside 20.
export const QUICK_MIN_GAP_MS = 5 * 1000;
export const QUICK_MAX_GAP_MS = 17 * 1000;
// Moving less than this since the last post doesn't count as "moved" (GPS
// jitter while standing still is several metres).
export const QUICK_MOVE_METRES = 10;
// Android fix interval during quick updates: well under QUICK_MIN_GAP_MS so a
// fix is on hand as soon as the 5-second floor has passed.
export const QUICK_FIX_INTERVAL_MS = 2 * 1000;

export const QUICK_DURATIONS = [
  { label: '5 minutes', ms: 5 * 60 * 1000 },
  { label: '15 minutes', ms: 15 * 60 * 1000 },
  { label: '30 minutes', ms: 30 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '2 hours', ms: 2 * 60 * 60 * 1000 },
  { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
] as const;

// What a plain tap on "Quick update" starts; the ▾ menu offers the rest.
export const QUICK_DEFAULT_MS = 30 * 60 * 1000;

// A heartbeat reuses the OS's last known fix if it's at most this old,
// rather than spinning up a fresh GPS lookup.
export const HEARTBEAT_FIX_MAX_AGE_MS = 60 * 1000;

// How often the foregrounded app re-checks everyone else's last known spot.
export const POLL_INTERVAL_MS = 60 * 1000;
// ...and how often while this phone or anyone else is on quick updates.
export const QUICK_POLL_INTERVAL_MS = 5 * 1000;

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
  // Where that post said we were ({lat, lng}), for quick updates' "has it
  // moved" check.
  lastSentPos: 'whereru:lastSentPos',
  // Quick updates run until this time (ms since epoch); absent when off.
  quickUntil: 'whereru:quickUntil',
} as const;
