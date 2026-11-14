/** First byte of a check-in write. The LoRa sketch sends CHECK IN when this is 1. */
export const PACKET_VERSION = 1;

/** Check-in target for the whole group. */
export const BROADCAST_ID = 0xff;

export const DEFAULT_THRESHOLD_M = 40;
export const THRESHOLD_MIN_M = 1;
export const THRESHOLD_MAX_M = 2000;

/** A follower not heard for this long is flagged. Meshtastic boards must report more often than this. */
export const DEFAULT_SILENCE_S = 120;
export const SILENCE_MIN_S = 30;
export const SILENCE_MAX_S = 3600;

/** A check-in with no acknowledgement by now shows No answer. A later acknowledgement still counts. */
export const CHECK_IN_TIMEOUT_MS = 120_000;

export function clampSilence(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_SILENCE_S;
  return Math.min(SILENCE_MAX_S, Math.max(SILENCE_MIN_S, Math.round(seconds)));
}
