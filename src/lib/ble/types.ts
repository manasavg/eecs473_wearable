
/**
 * Appendix C enums, in the same numeric order as the firmware header.
 *
 *   enum class Status : uint8_t { OK, CHECKIN_PENDING, NEED_HELP, OUT_OF_RANGE };
 *   enum class CmdType : uint8_t { CHECK_IN, SET_THRESHOLD };
 */
export enum Status {
  OK = 0,
  CHECKIN_PENDING = 1,
  NEED_HELP = 2,
  OUT_OF_RANGE = 3,
}

export enum CmdType {
  CHECK_IN = 0,
  SET_THRESHOLD = 1,
}

/** One wristband, as the beacon reports it. Distances are meters; angles are degrees. */
export interface FollowerInfo {
  deviceId: number;
  status: Status;
  /** 0–100, or null if the beacon has not sampled the divider yet. */
  batteryPercent: number | null;
  /** Null when UWB has failed (10 missed pings). Not the same as "past a lowered threshold". */
  distanceM: number | null;
  /**
   * Degrees relative to the beacon, which is clipped to the back of this phone.
   * 0 is straight ahead (top of the phone). Positive is clockwise.
   * Null when UWB has failed.
   */
  angleDeg: number | null;
  uwbOutOfRange: boolean;
}

/** Appendix C `AppCommand`. Threshold is meters; ignored unless type is SET_THRESHOLD. */
export interface AppCommand {
  type: CmdType;
  /** Wristband id, or BROADCAST_ID for the whole group. */
  targetId: number;
  thresholdMeters: number;
}

export interface LeaderStatus {
  batteryPercent: number | null;
}

export interface AlertNotice {
  deviceId: number;
  status: Status;
  uwbOutOfRange: boolean;
}

/** Lab-only counters from the demo stand-in. Real notifications do not carry these yet. */
export interface LabSample {
  missedPings: number;
  overThresholdCount: number;
}
