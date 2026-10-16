import {
  PACKET_VERSION,
  THRESHOLD_MAX_M,
  THRESHOLD_MIN_M,
} from "./constants";
import type { AlertNotice, AppCommand, FollowerInfo, LeaderStatus } from "./types";
import { CmdType, Status } from "./types";

/**
 * Byte layout shared with the ESP32. Full diagrams and a known test vector
 * live in PROTOCOL.md at the repo root.
 *
 * Appendix C carries floats inside the firmware. On the air, each follower
 * has to fit in one notification at the default ATT payload (20 bytes), so
 * the link uses integers:
 *
 *   battery     uint8 percent
 *   distance    uint16 centimeters, little-endian, 0xFFFF = no UWB fix
 *   angle       int16 centidegrees, little-endian, 0x7FFF = no UWB fix
 *   threshold   uint8 meters
 *
 * TODO(ble): Confirm the BU04 angle-of-arrival sign on the bench.
 * This app treats 0° as straight ahead and positive as clockwise.
 * If the module increases counterclockwise, set ANGLE_SIGN to -1.
 * That is the only line the dial needs.
 */
export const ANGLE_SIGN: 1 | -1 = 1;

export const FOLLOWER_PACKET_BYTES = 9;
export const LEADER_PACKET_BYTES = 3;
export const ALERT_PACKET_BYTES = 4;
export const COMMAND_PACKET_BYTES = 4;

const DISTANCE_UNKNOWN = 0xffff;
const ANGLE_UNKNOWN = 0x7fff;
const BATTERY_UNKNOWN = 0xff;

export function clampThreshold(meters: number): number {
  if (!Number.isFinite(meters)) return THRESHOLD_MAX_M;
  return Math.min(THRESHOLD_MAX_M, Math.max(THRESHOLD_MIN_M, Math.round(meters)));
}

export function encodeCommand(command: AppCommand): Uint8Array {
  const bytes = new Uint8Array(COMMAND_PACKET_BYTES);
  bytes[0] = PACKET_VERSION;
  bytes[1] = command.type;
  bytes[2] = command.targetId & 0xff;
  bytes[3] =
    command.type === CmdType.SET_THRESHOLD ? clampThreshold(command.thresholdMeters) : 0;
  return bytes;
}

export function decodeCommand(bytes: Uint8Array): AppCommand {
  assertPacket(bytes, COMMAND_PACKET_BYTES, "Command");
  const type = bytes[1];
  if (type !== CmdType.CHECK_IN && type !== CmdType.SET_THRESHOLD) {
    throw new Error(`Unknown command type ${type}. Expected CHECK_IN (0) or SET_THRESHOLD (1).`);
  }
  return {
    type,
    targetId: bytes[2],
    thresholdMeters: bytes[3],
  };
}

export function encodeFollower(info: FollowerInfo): Uint8Array {
  const bytes = new Uint8Array(FOLLOWER_PACKET_BYTES);
  const view = viewOf(bytes);
  bytes[0] = PACKET_VERSION;
  bytes[1] = info.deviceId & 0xff;
  bytes[2] = info.status;
  bytes[3] = encodeBattery(info.batteryPercent);
  view.setUint16(4, encodeDistance(info.distanceM), true);
  view.setInt16(6, encodeAngle(info.angleDeg), true);
  bytes[8] = info.uwbOutOfRange ? 0x01 : 0x00;
  return bytes;
}

export function decodeFollower(bytes: Uint8Array): FollowerInfo {
  assertPacket(bytes, FOLLOWER_PACKET_BYTES, "Follower");
  const view = viewOf(bytes);
  const deviceId = bytes[1];
  if (deviceId === 0xff) {
    throw new Error("Follower id 0xFF is the broadcast address, not a wristband.");
  }
  return {
    deviceId,
    status: decodeStatus(bytes[2]),
    batteryPercent: decodeBattery(bytes[3]),
    distanceM: decodeDistance(view.getUint16(4, true)),
    angleDeg: decodeAngle(view.getInt16(6, true)),
    uwbOutOfRange: (bytes[8] & 0x01) === 0x01,
  };
}

export function encodeLeader(status: LeaderStatus): Uint8Array {
  const bytes = new Uint8Array(LEADER_PACKET_BYTES);
  bytes[0] = PACKET_VERSION;
  bytes[1] = encodeBattery(status.batteryPercent);
  bytes[2] = 0;
  return bytes;
}

export function decodeLeader(bytes: Uint8Array): LeaderStatus {
  assertPacket(bytes, LEADER_PACKET_BYTES, "Leader");
  return { batteryPercent: decodeBattery(bytes[1]) };
}

export function encodeAlert(notice: AlertNotice): Uint8Array {
  const bytes = new Uint8Array(ALERT_PACKET_BYTES);
  bytes[0] = PACKET_VERSION;
  bytes[1] = notice.deviceId & 0xff;
  bytes[2] = notice.status;
  bytes[3] = notice.uwbOutOfRange ? 0x01 : 0x00;
  return bytes;
}

export function decodeAlert(bytes: Uint8Array): AlertNotice {
  assertPacket(bytes, ALERT_PACKET_BYTES, "Alert");
  return {
    deviceId: bytes[1],
    status: decodeStatus(bytes[2]),
    uwbOutOfRange: (bytes[3] & 0x01) === 0x01,
  };
}

export function viewToBytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function assertPacket(bytes: Uint8Array, size: number, name: string): void {
  if (bytes.byteLength < size) {
    throw new Error(`${name} packet is ${bytes.byteLength} bytes; this app expects ${size}.`);
  }
  if (bytes[0] !== PACKET_VERSION) {
    throw new Error(
      `${name} packet version ${bytes[0]} does not match this app (version ${PACKET_VERSION}). Update the ESP32 encoder and PACKET_VERSION together.`,
    );
  }
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function encodeBattery(percent: number | null): number {
  if (percent == null || !Number.isFinite(percent)) return BATTERY_UNKNOWN;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

function decodeBattery(raw: number): number | null {
  return raw === BATTERY_UNKNOWN ? null : Math.min(100, raw);
}

function encodeDistance(meters: number | null): number {
  if (meters == null || !Number.isFinite(meters)) return DISTANCE_UNKNOWN;
  const cm = Math.round(meters * 100);
  if (cm < 0 || cm >= DISTANCE_UNKNOWN) return DISTANCE_UNKNOWN;
  return cm;
}

function decodeDistance(raw: number): number | null {
  return raw === DISTANCE_UNKNOWN ? null : raw / 100;
}

function encodeAngle(degrees: number | null): number {
  if (degrees == null || !Number.isFinite(degrees)) return ANGLE_UNKNOWN;
  const centi = Math.round((degrees / ANGLE_SIGN) * 100);
  if (centi <= -18000 || centi >= 18000) {
    const wrapped = Math.max(-17999, Math.min(17999, centi));
    return wrapped;
  }
  return centi;
}

function decodeAngle(raw: number): number | null {
  if (raw === ANGLE_UNKNOWN) return null;
  return (raw / 100) * ANGLE_SIGN;
}

function decodeStatus(raw: number): Status {
  if (
    raw !== Status.OK &&
    raw !== Status.CHECKIN_PENDING &&
    raw !== Status.NEED_HELP &&
    raw !== Status.OUT_OF_RANGE
  ) {
    throw new Error(`Unknown status byte ${raw}.`);
  }
  return raw;
}
