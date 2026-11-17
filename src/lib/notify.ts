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

let lastId = 0;

/** A phone notification. Does nothing when permission was not granted. */
export async function notify(title: string, body: string): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== "granted") return;
      lastId = Math.max(lastId + 1, Date.now() % 2147483647) || 1;
      await LocalNotifications.schedule({
        notifications: [{ id: lastId, title, body, schedule: { at: new Date(Date.now() + 200) } }],
      });
      return;
    }
  } catch {
    /* Fall through to the browser notification. */
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  new Notification(title, { body });
}

export function notifyOutOfRange(meters: number, limitMeters: number, who = "Follower"): Promise<void> {
  return notify(`${who} is out of range`, outOfRangeBody(meters, limitMeters, who));
}

export function notifySilent(who: string, seconds: number, lastKnown: string | null = null): Promise<void> {
  const body = `${who} has not been heard for over ${formatDuration(seconds)}.`;
  return notify(`Lost contact with ${who}`, lastKnown ? `${body} Its ${lastKnown}.` : body);
}

export function notifyLinkLost(board: string | null): Promise<void> {
  return notify(
    "Lost the leader board",
    `The phone lost its Bluetooth link to ${board ?? "the leader board"}. Alerts are paused until you reconnect.`,
  );
}

export function notifyNoAnswer(who: string, reason: string): Promise<void> {
  return notify(`${who} did not answer the check-in`, reason);
}

/** "45 s", "3 min", "1 h 5 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
