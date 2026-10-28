import { Capacitor } from "@capacitor/core";

const TITLE = "Follower is out of range";

export function outOfRangeBody(meters: number, limitMeters: number): string {
  return `They are ${Math.round(meters)} m away. The limit is ${limitMeters} m.`;
}

/** Ask while the tap is still the user gesture. Later alerts only fire if this was granted. */
export async function ensureNotifyPermission(): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const current = await LocalNotifications.checkPermissions();
      if (current.display !== "granted") await LocalNotifications.requestPermissions();
      return;
    }
  } catch {
    /* The browser build has no native notification plugin. */
  }
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") await Notification.requestPermission();
}

export async function notifyOutOfRange(meters: number, limitMeters: number): Promise<void> {
  const body = outOfRangeBody(meters, limitMeters);
  try {
    if (Capacitor.isNativePlatform()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== "granted") return;
      await LocalNotifications.schedule({
        notifications: [
          {
            id: (Date.now() % 2147483647) || 1,
            title: TITLE,
            body,
            schedule: { at: new Date(Date.now() + 200) },
          },
        ],
      });
      return;
    }
  } catch {
    /* Fall through to the browser notification. */
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  new Notification(TITLE, { body });
}
