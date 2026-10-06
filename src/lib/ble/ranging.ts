import {
  MISSED_PINGS_LIMIT,
  SUSTAINED_OVER_THRESHOLD_CYCLES,
} from "./constants";
import { Status } from "./types";

/**
 * Stand-in for the leader beacon's ranging rules, used only by the demo trail.
 *
 * In beacon mode the phone does not apply this. It shows the status byte the
 * ESP32 already decided. These rules match the proposal:
 *
 *   - 10 missed UWB pings → out of range, and the fix is dropped
 *     (the module fails past ~40 m instead of returning a longer distance)
 *   - several cycles past a lowered separation line → out of range,
 *     while distance and angle are still valid
 *   - one bad sample does not alert
 *   - Need Help (3-second press) stays latched until the response button
 *   - a check-in in flight is reported as CHECKIN_PENDING unless Need Help is latched
 *
 * TODO(ble): If the ESP32 uses a different priority or a longer filter window,
 * change this file so the demo keeps matching the hardware.
 */

export interface RangeInput {
  distanceM: number | null;
  angleDeg: number | null;
  missedPings: number;
  overThresholdCount: number;
  thresholdM: number;
  needHelp: boolean;
  checkInPending: boolean;
}

export interface RangeDecision {
  status: Status;
  uwbOutOfRange: boolean;
  overThresholdCount: number;
  distanceM: number | null;
  angleDeg: number | null;
}

export function decideRange(input: RangeInput): RangeDecision {
  const uwbOut = input.missedPings >= MISSED_PINGS_LIMIT;
  let over = input.overThresholdCount;

  if (uwbOut) {
    over = 0;
  } else if (input.distanceM != null && input.distanceM > input.thresholdM) {
    over += 1;
  } else if (input.distanceM != null) {
    over = 0;
  }

  const pastLine = over >= SUSTAINED_OVER_THRESHOLD_CYCLES;
  const separated = uwbOut || pastLine;

  let status: Status;
  if (input.needHelp) status = Status.NEED_HELP;
  else if (input.checkInPending) status = Status.CHECKIN_PENDING;
  else if (separated) status = Status.OUT_OF_RANGE;
  else status = Status.OK;

  return {
    status,
    uwbOutOfRange: uwbOut,
    overThresholdCount: over,
    distanceM: uwbOut ? null : input.distanceM,
    angleDeg: uwbOut ? null : input.angleDeg,
  };
}

export function wrapAngle(degrees: number): number {
  const turns = (((degrees + 180) % 360) + 360) % 360;
  return turns - 180;
}
