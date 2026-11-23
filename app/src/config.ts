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

// iOS, normal mode: only hand over a new fix once the phone has moved this
// far. iOS has no "one fix every 5 minutes" setting (timeInterval is
// Android-only), so with no distance filter it delivers about one a second
// around the clock, which is most of the normal-mode battery drain. With the
// filter a phone sitting still gets no fixes at all and the heartbeat below
// fetches one every 5 minutes instead. Android keeps 0: its own 5-minute
// interval already spaces the fixes, and a filter there would only swap the
// OS's fix for the heartbeat's.
export const NORMAL_DISTANCE_METRES_IOS = 50;

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

// The longest quick updates can run, and the hard limit on the OS staying on
// quick-update settings (2-second GPS) for any reason: a duration is clamped
// to this, a stored end time further out than this is treated as expired,
// and if the OS is still on quick settings this long (plus
// QUICK_LIMIT_GRACE_MS) after they went on, the background side forces it
// back to normal, pausing sharing as a last resort.
export const QUICK_MAX_MS = 4 * 60 * 60 * 1000;
// Lets the ordinary end-of-quick switch at exactly 4 hours go first.
export const QUICK_LIMIT_GRACE_MS = 60 * 1000;

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

// One background send (fix lookup + post) normally finishes well inside a
// minute: every step that can wait has its own REQUEST_TIMEOUT_MS. If one is
// still marked as running after this long, something hung without ever
// settling, and the next tick stops waiting for it rather than skipping its
// turn forever.
export const IN_FLIGHT_STALE_MS = 90 * 1000;

// After a failed send the next try waits RETRY_BASE_MS, doubling with each
// further failure up to RETRY_MAX_MS (QUICK_MAX_GAP_MS during quick
// updates), and goes back to normal after the first success. Each try uses a
// fresh fix, so nothing is lost by not replaying the failed one; the point is
// not to spin a fix lookup and a request every 5 seconds for hours while the
// phone is offline, yet still catch the network coming back within a minute.
export const RETRY_BASE_MS = 5 * 1000;
export const RETRY_MAX_MS = 60 * 1000;

// When quick updates end in the background, switching the OS back to normal
// settings means restarting the location service, which Android 12+ may
// refuse or never answer from the background. Sends carry on regardless;
// the switch is retried this often until it works (opening the app always
// does it).
export const OS_SWITCH_RETRY_MS = 5 * 60 * 1000;

// The background status record is written at most this often for routine
// news (a fix arrived, another post succeeded); a change from success to
// failure or back, or a new error message, is written straight away.
export const BG_STATUS_SAVE_GAP_MS = 60 * 1000;

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
  // What the background side has been doing (BgStatus in storage.ts), so the
  // app can show why updates stopped.
  bgStatus: 'whereru:bgStatus',
  // When the OS was put on quick-update settings (ms since epoch); absent
  // once it's back on normal ones. Drives the QUICK_MAX_MS backstop.
  osQuickSince: 'whereru:osQuickSince',
  // Set when the backstop had to pause sharing; opening the app resumes it.
  resumeSharing: 'whereru:resumeSharing',
} as const;
