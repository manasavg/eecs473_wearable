import { checkInSecondsLeft, type ActivityEntry, type MemberState } from "./ble/app-client";
import { Status } from "./ble/types";

export function wristbandName(id: number, nicknames: Record<string, string>): string {
  const custom = nicknames[String(id)]?.trim();
  return custom || `Wristband ${id}`;
}

export function formatDistance(meters: number | null): string {
  if (meters == null || !Number.isFinite(meters)) return "—";
  return `${meters.toFixed(1)} m`;
}

export function formatBearing(angleDeg: number | null): string {
  if (angleDeg == null || !Number.isFinite(angleDeg)) return "Direction unavailable";
  const rounded = Math.round(angleDeg);
  if (Math.abs(rounded) <= 5) return "Straight ahead";
  if (Math.abs(rounded) >= 170) return "Behind you";
  if (rounded > 0) return `${rounded}° right`;
  return `${Math.abs(rounded)}° left`;
}

export function formatCompassBearing(headingDeg: number, angleDeg: number): string {
  const absolute = ((headingDeg + angleDeg) % 360 + 360) % 360;
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const name = names[Math.round(absolute / 45) % 8];
  return `${name} · ${Math.round(absolute)}°`;
}

export function statusLabel(status: Status): string {
  switch (status) {
    case Status.OK:
      return "OK";
    case Status.CHECKIN_PENDING:
      return "Check-in pending";
    case Status.NEED_HELP:
      return "Need help";
    case Status.OUT_OF_RANGE:
      return "Out of range";
  }
}

export type BatteryBand = "high" | "medium" | "low" | "unknown";

/** Glance bands for the leader. The wristband LED uses its own firmware thresholds. */
export function batteryBand(percent: number | null): BatteryBand {
  if (percent == null) return "unknown";
  if (percent >= 60) return "high";
  if (percent >= 20) return "medium";
  return "low";
}

export function formatAge(at: number | null, now: number): string {
  if (at == null) return "no packets yet";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function checkInLine(member: MemberState, now: number): string | null {
  if (member.status === Status.CHECKIN_PENDING) {
    const started = member.pendingSince ?? member.checkInSentAt;
    if (started == null) return "Wristband is vibrating";
    const left = checkInSecondsLeft(started, now);
    if (left <= 0) return "No response. The haptic stopped at 60 seconds.";
    return `Vibrating · ${left}s left for the button`;
  }
  if (member.checkInSentAt && member.status === Status.NEED_HELP) {
    const left = checkInSecondsLeft(member.checkInSentAt, now);
    if (left <= 0) return "Check-in timed out. They still need help.";
    return `Check-in sent · still needs help · ${left}s`;
  }
  if (member.checkInSentAt && member.status === Status.OK) {
    const age = now - member.checkInSentAt;
    if (age < 2500) return "Sending check-in";
  }
  if (member.status === Status.NEED_HELP) {
    return "Red LED. Haptic runs until they press the button.";
  }
  return null;
}

export function activityText(
  entry: ActivityEntry,
  nameFor: (id: number) => string,
): string {
  switch (entry.kind) {
    case "linked":
      return entry.message ? `Linked to ${entry.message}` : "Beacon linked";
    case "checkin":
      return entry.deviceId == null
        ? "Check-in sent to the whole group"
        : `Check-in sent to ${nameFor(entry.deviceId)}`;
    case "answered":
      return entry.deviceId == null ? "Check-in answered" : `${nameFor(entry.deviceId)} answered OK`;
    case "help":
      return entry.deviceId == null ? "Someone needs help" : `${nameFor(entry.deviceId)} needs help`;
    case "separated":
      return entry.deviceId == null
        ? "Someone is out of range"
        : `${nameFor(entry.deviceId)} is out of range`;
    case "returned":
      return entry.deviceId == null
        ? "Back within the line"
        : `${nameFor(entry.deviceId)} is back within the line`;
    case "threshold":
      return `Separation line set to ${entry.meters ?? "—"} m`;
    case "cleared":
      return "Wristbands cleared. Hold Sync on the beacon and both bands to assign IDs again.";
    case "error":
      return entry.message ?? "Beacon error";
  }
}
