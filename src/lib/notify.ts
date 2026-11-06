import { Capacitor } from "@capacitor/core";

export function outOfRangeBody(meters: number, limitMeters: number, who = "Follower"): string {
  return `${who} is ${Math.round(meters)} m away. The limit is ${limitMeters} m.`;
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

export async function notifyOutOfRange(
  meters: number,
  limitMeters: number,
  who = "Follower",
): Promise<void> {
  const title = `${who} is out of range`;
  const body = outOfRangeBody(meters, limitMeters, who);
  try {
    if (Capacitor.isNativePlatform()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== "granted") return;
      await LocalNotifications.schedule({
        notifications: [
          {
            id: (Date.now() % 2147483647) || 1,
            title,
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
  new Notification(title, { body });
}
