import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { LOCATION_TASK_NAME, MIN_SEND_GAP_MS, UPDATE_INTERVAL_MS } from './config';
import { loadLastSentAt, loadProfile, saveLastSentAt } from './storage';
import { locationToPayload, postLocation } from './api';

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

  // iOS can invoke this task every few seconds regardless of the interval we
  // asked for. Nothing is sent until a full window has passed since the last
  // post (background or manual); everything else is dropped here, before any
  // network traffic.
  const now = Date.now();
  const lastSentAt = await loadLastSentAt();
  if (now - lastSentAt < MIN_SEND_GAP_MS) return;

  // Read the profile fresh each time so a changed server URL or token takes
  // effect on the next update without restarting sharing.
  const profile = await loadProfile();
  if (!profile) return; // not configured yet, nothing to send to

  try {
    await postLocation(profile.serverUrl, profile.token, locationToPayload(latest));
    await saveLastSentAt(now);
  } catch (err) {
    // Not recorded as sent, so the next update retries straight away.
    console.error('[locationTask] failed to send location:', err);
  }
});

export async function isSharing(): Promise<boolean> {
  return TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
}

export async function startSharing(): Promise<void> {
  if (await isSharing()) return;

  await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
    accuracy: Location.Accuracy.Balanced,
    // Android: a strict minimum interval between updates. iOS ignores this
    // (it's documented as Android-only) -- see deferredUpdatesInterval and
    // the gap check in the task above for how iOS cadence is handled.
    timeInterval: UPDATE_INTERVAL_MS,
    distanceInterval: 0,
    // iOS, background only: ask the OS to batch updates and hand them over
    // no more than once per interval. Best-effort; the task enforces the
    // cadence itself regardless.
    deferredUpdatesInterval: UPDATE_INTERVAL_MS,
    deferredUpdatesDistance: 0,
    activityType: Location.ActivityType.Other,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Honey Where Are You?',
      notificationBody: 'Sharing your location with your group',
    },
  });
}

export async function stopSharing(): Promise<void> {
  if (await isSharing()) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }
}
