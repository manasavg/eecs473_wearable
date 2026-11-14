import { DEFAULT_SILENCE_S, DEFAULT_THRESHOLD_M, clampSilence } from "./ble/constants";
import type { LastKnown } from "./ble/app-client";
import { clampThreshold } from "./ble/protocol";

const KEY = "excursion.settings";

export interface SavedSettings {
  thresholdMeters: number;
  silenceSeconds: number;
  requireConfirm: boolean;
}

/** The range and silence limits from the last session on this phone. */
export function loadSettings(): SavedSettings {
  const fallback = {
    thresholdMeters: DEFAULT_THRESHOLD_M,
    silenceSeconds: DEFAULT_SILENCE_S,
    requireConfirm: true,
  };
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SavedSettings>;
    return {
      thresholdMeters:
        typeof parsed.thresholdMeters === "number"
          ? clampThreshold(parsed.thresholdMeters)
          : fallback.thresholdMeters,
      silenceSeconds:
        typeof parsed.silenceSeconds === "number"
          ? clampSilence(parsed.silenceSeconds)
          : fallback.silenceSeconds,
      requireConfirm:
        typeof parsed.requireConfirm === "boolean" ? parsed.requireConfirm : fallback.requireConfirm,
    };
  } catch {
    return fallback;
  }
}

export function saveSettings(settings: SavedSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode */
  }
}

const LAST_KNOWN_KEY = "excursion.lastKnown";
/** Older fixes are dropped. */
const LAST_KNOWN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Each board's last known fix, so it survives a reconnect or an app restart. */
export function loadLastKnown(): Record<number, LastKnown> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(LAST_KNOWN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<LastKnown>>;
    const out: Record<number, LastKnown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const { lat, lon, at } = value ?? {};
      if (typeof lat !== "number" || typeof lon !== "number" || typeof at !== "number") continue;
      if (Date.now() - at > LAST_KNOWN_MAX_AGE_MS) continue;
      out[Number(key)] = { lat, lon, at };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLastKnown(lastKnown: Record<number, LastKnown>): void {
  try {
    localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify(lastKnown));
  } catch {
    /* private mode */
  }
}
