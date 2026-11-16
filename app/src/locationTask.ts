import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  HEARTBEAT_FIX_MAX_AGE_MS,
  HEARTBEAT_GAP_MS,
  HEARTBEAT_TICK_MS,
  LOCATION_TASK_NAME,
  MIN_SEND_GAP_MS,
  QUICK_FIX_INTERVAL_MS,
  QUICK_MAX_GAP_MS,
  QUICK_MIN_GAP_MS,
  QUICK_MOVE_METRES,
  REQUEST_TIMEOUT_MS,
  UPDATE_INTERVAL_MS,
} from './config';
import {
  clearQuickUntil,
  loadLastSent,
  loadProfile,
  loadQuickUntil,
  saveLastSent,
  saveQuickUntil,
  type LastSent,
} from './storage';
import { locationToPayload, postLocation } from './api';

type Mode = 'normal' | 'quick';

// Must be defined at module scope (not inside a component) so the OS can
// re-run this file's top level and reattach the handler after the app has
// been killed and is woken up in the background.
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('[locationTask] error:', error.message);
    return;
  }

  const { locations } = (data as { locations: Location.LocationObject[] }) ?? { locations: [] };
  const latest = locations?.[locations.length - 1];
  if (!latest) return;

  await maybeSend(latest);
});

// The OS only calls the task above when it has a new fix, and iOS stops
// delivering them when the phone sits still. This timer is the backstop: if
// nothing has gone out for too long (5 minutes normally, ~17 seconds during
// quick updates) it looks up a position itself and posts it, so the server
// always has a recent "still here" from a sharing phone. JS keeps running in
// the background while location updates are active (that's what the
// background location mode / Android foreground service are for), so the
// timer keeps ticking there too.
setInterval(() => {
  maybeSend(null);
}, HEARTBEAT_TICK_MS);

// One decision-and-post at a time: the task and the heartbeat share the same
// JS runtime and could otherwise both see "due" and post twice. A caller
// that finds one in flight just drops its turn; another comes within seconds.
let inFlight = false;

// loc is a fix the OS just delivered, or null for a heartbeat check.
async function maybeSend(loc: Location.LocationObject | null): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const now = Date.now();
    const mode = await currentMode(now);
    const last = await loadLastSent();

    if (loc) {
      if (!shouldSendFix(loc, mode, last, now)) return;
    } else {
      // Heartbeat: only when overdue, and only while sharing is actually on.
      const overdue = mode === 'quick' ? QUICK_MAX_GAP_MS : HEARTBEAT_GAP_MS;
      if (now - last.at < overdue) return;
      if (!(await isSharing())) return;
      loc = await heartbeatFix(mode);
      if (!loc) return;
    }

    // Read the profile fresh each time so a changed server URL or token takes
    // effect on the next update without restarting sharing.
    const profile = await loadProfile();
    if (!profile) return; // not configured yet, nothing to send to

    const payload = locationToPayload(loc, mode === 'quick');
    await postLocation(profile.serverUrl, profile.token, payload);
    await saveLastSent(now, payload);
  } catch (err) {
    // Not recorded as sent, so the next fix or heartbeat retries. With no
    // connectivity that's every few seconds, but each try is cheap and fails
    // fast.
    console.error('[locationTask] failed to send location:', err);
  } finally {
    inFlight = false;
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
async function heartbeatFix(mode: Mode): Promise<Location.LocationObject | null> {
  const recent = await Location.getLastKnownPositionAsync({ maxAge: HEARTBEAT_FIX_MAX_AGE_MS });
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
    return Location.getLastKnownPositionAsync();
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
async function currentMode(now: number): Promise<Mode> {
  const until = await loadQuickUntil();
  if (!until) return 'normal';
  if (now < until) return 'quick';
  await clearQuickUntil();
  if (await isSharing()) await applyMode('normal');
  return 'normal';
}

function taskOptions(mode: Mode): Location.LocationTaskOptions {
  const quick = mode === 'quick';
  const interval = quick ? QUICK_FIX_INTERVAL_MS : UPDATE_INTERVAL_MS;
  return {
    // Quick updates use GPS so "has it moved 10 m" means something; normal
    // mode makes do with the cheaper wifi/cell fix.
    accuracy: quick ? Location.Accuracy.High : Location.Accuracy.Balanced,
    // Android: a strict minimum interval between updates. iOS ignores this
    // (it's documented as Android-only) -- see deferredUpdatesInterval and
    // the gap checks in maybeSend for how iOS cadence is handled.
    timeInterval: interval,
    distanceInterval: 0,
    // iOS, background only: ask the OS to batch updates and hand them over
    // no more than once per interval. Best-effort; maybeSend enforces the
    // cadence itself regardless.
    deferredUpdatesInterval: interval,
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
async function applyMode(mode: Mode): Promise<void> {
  await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, taskOptions(mode));
}

export async function isSharing(): Promise<boolean> {
  return TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
}

export async function startSharing(): Promise<void> {
  if (await isSharing()) return;
  await applyMode(await currentMode(Date.now()));
}

export async function stopSharing(): Promise<void> {
  await clearQuickUntil();
  if (await isSharing()) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }
}

// Turns sharing on if it isn't already (the caller must have the location
// permissions), in quick mode until now + durationMs. Picking a duration
// again while quick updates are running replaces the end time. Returns the
// end time.
export async function startQuickUpdates(durationMs: number): Promise<number> {
  const until = Date.now() + durationMs;
  await saveQuickUntil(until);
  await applyMode('quick');
  return until;
}

// Back to normal updates; sharing stays on.
export async function stopQuickUpdates(): Promise<void> {
  await clearQuickUntil();
  if (await isSharing()) await applyMode('normal');
}
