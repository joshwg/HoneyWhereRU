import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { LOCATION_TASK_NAME, UPDATE_INTERVAL_MS } from './config';
import { loadProfile } from './storage';
import { postLocation } from './api';

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

  const profile = await loadProfile();
  if (!profile) return; // not configured yet, nothing to send to

  try {
    await postLocation(profile.serverUrl, profile.token, {
      lat: latest.coords.latitude,
      lng: latest.coords.longitude,
      accuracy: latest.coords.accuracy,
      timestamp: latest.timestamp,
    });
  } catch (err) {
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
    // Android honors this as a strict minimum interval. iOS treats location
    // updates as event-driven (movement-based) rather than timer-based, so
    // cadence there is best-effort -- see README for details.
    timeInterval: UPDATE_INTERVAL_MS,
    distanceInterval: 0,
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
