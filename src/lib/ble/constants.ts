/**
 * Numbers from the Guided Excursion Wearable proposal.
 * The phone displays them. The beacon firmware enforces them.
 * The demo trail (mock-transport.ts) uses this file as its stand-in firmware.
 */

/** Repeating leader cycle in Figure 5. Followers sleep until the next one. */
export const CYCLE_MS = 2000;

/** UWB two-way ranging ceiling. Past this, the module fails a ping instead of returning a distance. */
export const UWB_RANGE_M = 40;

/** Miss this many UWB pings in a row (~20 s at one ping per cycle) and the follower is out of range. */
export const MISSED_PINGS_LIMIT = 10;

/**
 * A single distance past the separation line is ignored (trees, a body, a bad sample).
 * The alert waits until this many cycles in a row agree.
 * TODO(ble): Keep this in sync with the filter on the ESP32. The phone does not
 * re-decide "out of range" from raw distances once the real beacon is connected.
 */
export const SUSTAINED_OVER_THRESHOLD_CYCLES = 3;

/** Default separation line. The proposal allows the leader to set it lower after field tests. */
export const DEFAULT_THRESHOLD_M = 40;

/** Tightest line the app will send. Below this, ordinary trail spacing would alarm constantly. */
export const THRESHOLD_MIN_M = 5;

/** The line cannot exceed the UWB ceiling. LoRa check-ins cover the long range separately. */
export const THRESHOLD_MAX_M = UWB_RANGE_M;

/** Haptic on a check-in runs until the wristband button, and never longer than this. */
export const CHECKIN_VIBRATE_MS = 60_000;

/** Wire format version. Bump together with the ESP32 encoder. */
export const PACKET_VERSION = 1;

/**
 * Appendix C uses 0xFF as the whole-group target.
 * A check-in or threshold write with this id applies to every wristband.
 */
export const BROADCAST_ID = 0xff;
