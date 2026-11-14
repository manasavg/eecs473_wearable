import { DEFAULT_SILENCE_S, DEFAULT_THRESHOLD_M, clampSilence } from "./ble/constants";
import { clampThreshold } from "./ble/protocol";

const KEY = "excursion.settings";

export interface SavedSettings {
  thresholdMeters: number;
  silenceSeconds: number;
}

/** The range and silence limits from the last session on this phone. */
export function loadSettings(): SavedSettings {
  const fallback = { thresholdMeters: DEFAULT_THRESHOLD_M, silenceSeconds: DEFAULT_SILENCE_S };
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
