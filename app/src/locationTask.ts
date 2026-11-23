import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  HEARTBEAT_FIX_MAX_AGE_MS,
  HEARTBEAT_GAP_MS,
  HEARTBEAT_TICK_MS,
  BG_STATUS_SAVE_GAP_MS,
  IN_FLIGHT_STALE_MS,
  LOCATION_TASK_NAME,
  MIN_SEND_GAP_MS,
  OS_SWITCH_RETRY_MS,
  NORMAL_DISTANCE_METRES_IOS,
  QUICK_FIX_INTERVAL_MS,
  QUICK_LIMIT_GRACE_MS,
  QUICK_MAX_MS,
  QUICK_MAX_GAP_MS,
  QUICK_MIN_GAP_MS,
  QUICK_MOVE_METRES,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  UPDATE_INTERVAL_MS,
} from './config';
import {
  clearQuickUntil,
  loadBgStatus,
  loadLastSent,
  loadOsQuickSince,
  loadProfile,
  loadQuickUntil,
  loadResumeSharing,
  saveBgStatus,
  saveLastSent,
  saveOsQuickSince,
  saveQuickUntil,
  saveResumeSharing,
  type BgStatus,
  type LastSent,
} from './storage';
import { locationToPayload, postLocation } from './api';

type Mode = 'normal' | 'quick';

// The background status the app shows (BgStatus in storage.ts). One shared
// object, loaded once and changed in place by noteStatus; the update
// function returns true when the change is news that should be saved now
// (a failure, a recovery, a hung send), otherwise saves are spaced out by
// BG_STATUS_SAVE_GAP_MS because fixes can arrive every couple of seconds.
let bgStatus: Promise<BgStatus> | null = null;
let bgStatusSavedAt = 0;

async function noteStatus(update: (s: BgStatus) => boolean | void): Promise<void> {
  try {
    bgStatus ??= loadBgStatus();
    const status = await bgStatus;
    const urgent = update(status) === true;
    const now = Date.now();
    if (!urgent && now - bgStatusSavedAt < BG_STATUS_SAVE_GAP_MS) return;
    bgStatusSavedAt = now;
    await saveBgStatus(status);
  } catch (err) {
    console.warn('[locationTask] could not save background status:', err);
  }
}

// This file's top level runs once per JS runtime: when the app is opened,
// or when the OS starts the app in the background to deliver a location.
// A recent time here after a long silence means the process had been killed.
void noteStatus((s) => {
  s.startedAt = Date.now();
  return true;
});

// Must be defined at module scope (not inside a component) so the OS can
// re-run this file's top level and reattach the handler after the app has
// been killed and is woken up in the background.
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('[locationTask] error:', error.message);
    const message = `Location service error: ${error.message}`;
    void noteStatus((s) => {
      const news = s.error !== message;
      s.error = message;
      s.errorAt = Date.now();
      return news;
    });
    return;
  }

  const { locations } = (data as { locations: Location.LocationObject[] }) ?? { locations: [] };
  const latest = locations?.[locations.length - 1];
  if (!latest) return;
  void noteStatus((s) => {
    s.fixAt = Date.now();
  });

  await maybeSend(latest);
});

// The OS only calls the task above when it has a new fix, and in normal mode
// iOS delivers none while the phone sits still (see
// NORMAL_DISTANCE_METRES_IOS). This timer is the backstop: if nothing has
// gone out for too long (5 minutes normally, ~17 seconds during quick
// updates) it looks up a position itself and posts it, so the server always
// has a recent "still here" from a sharing phone. JS keeps running in the
// background while location updates are active (that's what the background
// location mode / Android foreground service are for), so the timer keeps
// ticking there too.
//
// The tick runs every 5 seconds around the clock, so it first checks the
// copies below instead of reading storage each time. They're only a filter:
// once they say a heartbeat may be due, maybeSend reads the stored values,
// which are what count. Anything else that posts (the "Send now" button)
// only makes the copy too old, which costs one storage read to correct.
let knownLastSentAt: number | null = null; // null: not read yet
let knownQuickUntil: number | null = null; // 0: quick updates off

setInterval(() => {
  if (knownLastSentAt !== null && knownQuickUntil !== null) {
    const now = Date.now();
    const overdue = now < knownQuickUntil ? QUICK_MAX_GAP_MS : HEARTBEAT_GAP_MS;
    if (now - knownLastSentAt < overdue) return;
  }
  maybeSend(null);
}, HEARTBEAT_TICK_MS);

// One decision-and-post at a time: the task and the heartbeat share the same
// JS runtime and could otherwise both see "due" and post twice. A caller
// that finds one in flight just drops its turn; another comes within seconds.
//
// If a send is somehow still "in flight" after IN_FLIGHT_STALE_MS, a call
// that never settled has hung it, and waiting on it would silently skip
// every turn from then on while the notification still says sharing is on.
// The next caller abandons it and goes ahead; runId keeps the abandoned
// send's eventual finally from clearing the newer one's flag.
let inFlightSince = 0; // 0: nothing in flight
let runId = 0;

// Backoff after failed sends (see RETRY_BASE_MS). Kept in memory only: a
// fresh runtime simply tries straight away.
let failures = 0;
let retryAt = 0; // no try before this time (ms since epoch); 0: none pending

// loc is a fix the OS just delivered, or null for a heartbeat check.
async function maybeSend(loc: Location.LocationObject | null): Promise<void> {
  const now = Date.now();
  if (inFlightSince) {
    if (now - inFlightSince < IN_FLIGHT_STALE_MS) return;
    console.warn(`[locationTask] previous send hung for ${Math.round((now - inFlightSince) / 1000)}s; abandoning it`);
    void noteStatus((s) => {
      s.unstuckCount += 1;
      s.unstuckAt = now;
      return true;
    });
  }
  if (now < retryAt) return;
  const myRun = ++runId;
  inFlightSince = now;
  let mode: Mode = 'normal';
  try {
    mode = await currentMode(now);
    if (!(await enforceQuickLimit(mode, now))) return; // sharing was paused
    if ((await osQuickSince()) > 0 && mode === 'normal') {
      // Still on quick settings after quick updates ended: keep trying to
      // switch back (see OS_SWITCH_RETRY_MS) without holding up this send.
      switchOsModeInBackground('normal', now);
    }
    const last = await loadLastSent();
    knownLastSentAt = last.at;

    if (loc) {
      if (!shouldSendFix(loc, mode, last, now)) return;
    } else {
      // Heartbeat: only when overdue, and only while sharing is actually on.
      const overdue = mode === 'quick' ? QUICK_MAX_GAP_MS : HEARTBEAT_GAP_MS;
      if (now - last.at < overdue) return;
      if (!(await isSharing())) return;
      loc = await heartbeatFix(mode);
      if (!loc) throw new Error('The phone had no location to give (is Location turned on?)');
    }

    // Read the profile fresh each time so a changed server URL or token takes
    // effect on the next update without restarting sharing.
    const profile = await loadProfile();
    if (!profile) throw new Error('Not set up: no server URL or token saved');

    const payload = locationToPayload(loc, mode === 'quick');
    await postLocation(profile.serverUrl, profile.token, payload);
    await saveLastSent(now, payload);
    knownLastSentAt = now;
    failures = 0;
    retryAt = 0;
    void noteStatus((s) => {
      const recovered = !s.ok;
      s.attemptAt = now;
      s.ok = true;
      return recovered;
    });
  } catch (err) {
    // Not recorded as sent, so the next fix or heartbeat retries. With no
    // connectivity that's every few seconds, but each try is cheap and fails
    // fast.
    failures += 1;
    const cap = mode === 'quick' ? QUICK_MAX_GAP_MS : RETRY_MAX_MS;
    const wait = Math.min(RETRY_BASE_MS * 2 ** Math.min(failures - 1, 10), cap);
    retryAt = now + wait;
    console.error(`[locationTask] failed to send location (try ${failures}, next in ${wait / 1000}s):`, err);
    const message = err instanceof Error ? err.message : String(err);
    void noteStatus((s) => {
      const news = s.ok || s.error !== message;
      s.attemptAt = now;
      s.ok = false;
      s.error = message;
      s.errorAt = now;
      return news;
    });
  } finally {
    if (runId === myRun) inFlightSince = 0;
  }
}

// Normal: one post per ~5-minute window, whatever iOS delivers in between.
// Quick: post as soon as the phone has moved, but at most every 5 seconds;
// if it hasn't moved, post anyway once the 20-second ceiling comes round.
function shouldSendFix(loc: Location.LocationObject, mode: Mode, last: LastSent, now: number): boolean {
  const gap = now - last.at;
  if (mode === 'normal') return gap >= MIN_SEND_GAP_MS;
  if (gap < QUICK_MIN_GAP_MS) return false;
  if (gap >= QUICK_MAX_GAP_MS || !last.pos) return true;
  return distanceMetres(last.pos.lat, last.pos.lng, loc.coords.latitude, loc.coords.longitude) >= QUICK_MOVE_METRES;
}

// A position for a heartbeat. The location service is already running, so
// the OS's last fix is usually fresh enough; only if it isn't do we ask for
// a new one (which can take a few seconds to settle). If that fails too, the
// last fix still goes out with its own timestamp: it keeps the "last seen"
// time current, and the server works out speed from fix timestamps, so an
// old fix doesn't read as "stopped".
//
// Every lookup has a timeout so a call that never answers can't hold up the
// send (see inFlightSince).
async function heartbeatFix(mode: Mode): Promise<Location.LocationObject | null> {
  const recent = await withTimeout(
    Location.getLastKnownPositionAsync({ maxAge: HEARTBEAT_FIX_MAX_AGE_MS }),
    REQUEST_TIMEOUT_MS
  ).catch(() => null);
  if (recent) return recent;
  try {
    return await withTimeout(
      Location.getCurrentPositionAsync({
        accuracy: mode === 'quick' ? Location.Accuracy.High : Location.Accuracy.Balanced,
      }),
      REQUEST_TIMEOUT_MS
    );
  } catch (err) {
    console.warn('[locationTask] no fresh fix for heartbeat:', err);
    return withTimeout(Location.getLastKnownPositionAsync(), REQUEST_TIMEOUT_MS);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Quick updates are on until the stored time. Once that passes, this is
// where they end: the stored time is cleared and the OS is switched back to
// the normal, battery-friendly settings.
//
// An end time more than QUICK_MAX_MS away can't have been set by
// startQuickUpdates (it clamps), so it comes from the clock having been set
// back or a corrupt value; it's ended like an expired one.
async function currentMode(now: number): Promise<Mode> {
  const until = await loadQuickUntil();
  knownQuickUntil = until;
  if (!until) return 'normal';
  if (now < until && until - now <= QUICK_MAX_MS) return 'quick';
  await clearQuickUntil();
  knownQuickUntil = 0;
  if (await isSharing()) switchOsModeInBackground('normal', now);
  return 'normal';
}

// When the OS was put on quick settings, 0 when it's on normal ones. Stored
// (not just kept in memory) so a runtime the OS restarts in the background
// still knows the 2-second GPS is on and how long it has been. null: not
// read yet in this runtime.
let knownOsQuickSince: number | null = null;
let osSwitchTriedAt = 0;

async function osQuickSince(): Promise<number> {
  knownOsQuickSince ??= await loadOsQuickSince();
  return knownOsQuickSince;
}

async function setOsQuickSince(ms: number): Promise<void> {
  knownOsQuickSince = ms;
  await saveOsQuickSince(ms);
}

// The backstop behind QUICK_MAX_MS. Returns false if it had to pause
// sharing. Normally quick updates have long since ended on time and the OS
// has been switched back, so this is just one in-memory comparison.
async function enforceQuickLimit(mode: Mode, now: number): Promise<boolean> {
  const since = await osQuickSince();
  if (!since || now - since < QUICK_MAX_MS + QUICK_LIMIT_GRACE_MS) return true;
  console.warn('[locationTask] quick settings still on after the limit; forcing normal');
  if (mode === 'quick') {
    // Shouldn't happen (durations are clamped and restarting quick updates
    // resets the clock), but the limit holds even so.
    await clearQuickUntil();
    knownQuickUntil = 0;
  }
  try {
    await withTimeout(applyMode('normal'), REQUEST_TIMEOUT_MS);
    return true;
  } catch (err) {
    console.warn('[locationTask] could not switch to normal; pausing sharing:', err);
  }
  // Last resort: stop location updates altogether. Stopping is allowed from
  // the background even where restarting isn't. The app resumes sharing in
  // normal mode the next time it's opened (see ensureSharingRunning).
  await saveResumeSharing(true);
  await setOsQuickSince(0);
  await withTimeout(Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME), REQUEST_TIMEOUT_MS).catch((err) =>
    console.warn('[locationTask] could not stop location updates:', err)
  );
  void noteStatus((s) => {
    s.error = 'Quick updates could not be turned off in the background, so sharing was paused. Opening the app resumed it.';
    s.errorAt = now;
    return true;
  });
  return false;
}

// Switch the OS's settings from the background, without waiting for it.
// On Android 12+ restarting the location service from the background can be
// refused or simply never answer; that once left a phone on 2-second GPS
// with every send blocked behind the unanswered call. So it's never awaited
// by a send, gets a timeout, and is retried every OS_SWITCH_RETRY_MS.
function switchOsModeInBackground(mode: Mode, now: number): void {
  if (now - osSwitchTriedAt < OS_SWITCH_RETRY_MS) return;
  osSwitchTriedAt = now;
  withTimeout(applyMode(mode), REQUEST_TIMEOUT_MS).catch((err) => {
    const message = `Could not switch location updates to ${mode} in the background (${
      err instanceof Error ? err.message : String(err)
    }); opening the app will`;
    console.warn('[locationTask]', message);
    void noteStatus((s) => {
      const news = s.error !== message;
      s.error = message;
      s.errorAt = Date.now();
      return news;
    });
  });
}

function taskOptions(mode: Mode): Location.LocationTaskOptions {
  const quick = mode === 'quick';
  const interval = quick ? QUICK_FIX_INTERVAL_MS : UPDATE_INTERVAL_MS;
  return {
    // Quick updates use GPS so "has it moved 10 m" means something; normal
    // mode makes do with the cheaper wifi/cell fix.
    accuracy: quick ? Location.Accuracy.High : Location.Accuracy.Balanced,
    // Android: a strict minimum interval between updates. iOS ignores this
    // (it's documented as Android-only); there the distance filter keeps a
    // still phone from getting a fix every second, and the gap checks in
    // maybeSend enforce the cadence.
    timeInterval: interval,
    distanceInterval: !quick && Platform.OS === 'ios' ? NORMAL_DISTANCE_METRES_IOS : 0,
    // Background only: expo-location holds fixes in memory and runs the task
    // once per interval, so iOS doesn't wake JS for every fix. Android is
    // left at 0: it already spaces fixes by timeInterval, and holding them
    // back too could push a fix arriving at 4:59.8 out to the 10-minute
    // mark.
    deferredUpdatesInterval: Platform.OS === 'ios' ? interval : 0,
    deferredUpdatesDistance: 0,
    activityType: Location.ActivityType.Other,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Honey Where Are You?',
      notificationBody: quick
        ? 'Quick updates on: sharing your location every few seconds'
        : 'Sharing your location with your group',
    },
  };
}

// Starting updates for a task that's already running just replaces its
// options (both platforms restart the location request with the new ones),
// so this is also how we switch between normal and quick.
//
// Android, in the background: expo-location refuses any start that carries
// `foregroundService` (ForegroundServiceStartNotAllowedException), since it
// can't start the service from there. For a task that's already running,
// though, new options only restart the location request and leave the
// running service alone, so the retry without `foregroundService` changes
// the GPS settings while the service and its notification carry on. The
// notification keeps its old text until the app is opened, when
// ensureSharingRunning applies the full options again.
async function applyMode(mode: Mode): Promise<void> {
  const options = taskOptions(mode);
  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, options);
  } catch (err) {
    if (Platform.OS !== 'android' || !(await isSharing())) throw err;
    const { foregroundService: _, ...withoutService } = options;
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, withoutService);
  }
  osSwitchTriedAt = 0; // a later switch shouldn't wait on an old try's retry gap
  if (mode === 'normal') await setOsQuickSince(0);
  else if (!(await osQuickSince())) await setOsQuickSince(Date.now());
}

export async function isSharing(): Promise<boolean> {
  return TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
}

export async function startSharing(): Promise<void> {
  if (await isSharing()) return;
  await applyMode(await currentMode(Date.now()));
}

// Called whenever the app comes to the foreground. If sharing is on, restart
// the location request: Android can kill the foreground service (battery
// savers, vendor "sleeping apps" lists) while the task stays registered, and
// then nothing would ever deliver a fix again. Starting it from the
// foreground is always allowed; from the background Android 12+ refuses.
// Also clears any send backoff so the first try after opening is immediate.
//
// It's also where sharing comes back after the QUICK_MAX_MS backstop had to
// pause it.
export async function ensureSharingRunning(): Promise<void> {
  if (!(await isSharing())) {
    if (!(await loadResumeSharing())) return;
    await saveResumeSharing(false);
  }
  retryAt = 0;
  await applyMode(await currentMode(Date.now()));
  maybeSend(null);
}

export async function stopSharing(): Promise<void> {
  await clearQuickUntil();
  knownQuickUntil = 0;
  await saveResumeSharing(false);
  if (await isSharing()) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }
  await setOsQuickSince(0);
}

// Turns sharing on if it isn't already (the caller must have the location
// permissions), in quick mode until now + durationMs. Picking a duration
// again while quick updates are running replaces the end time, and restarts
// the QUICK_MAX_MS clock: that's someone choosing more time, not quick
// updates being stuck. The duration is clamped to QUICK_MAX_MS. Returns the
// end time.
export async function startQuickUpdates(durationMs: number): Promise<number> {
  const now = Date.now();
  const until = now + Math.min(Math.max(durationMs, 0), QUICK_MAX_MS);
  await saveQuickUntil(until);
  knownQuickUntil = until;
  await saveResumeSharing(false);
  await applyMode('quick');
  await setOsQuickSince(now);
  return until;
}

// Back to normal updates; sharing stays on.
export async function stopQuickUpdates(): Promise<void> {
  await clearQuickUntil();
  knownQuickUntil = 0;
  if (await isSharing()) await applyMode('normal');
}
