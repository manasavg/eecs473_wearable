import { PACKET_VERSION } from "./constants";
import {
  FOLLOWER_PACKET_BYTES,
  LEADER_PACKET_BYTES,
  decodeFollower,
  decodeLeader,
} from "./protocol";
import type { BleEvent } from "./transport";
import type { FollowerInfo } from "./types";

/**
 * Bytes from firmware/excursion_device/excursion_device.ino.
 *
 * The connected board is the leader. TX notifies:
 *
 *   'G', fix, int32 latitude * 1e7, int32 longitude * 1e7
 *   'F', follower id, fix, int32 latitude * 1e7, int32 longitude * 1e7
 *   'M', follower id, uint32 centimeters. 0xFFFFFFFF means no distance
 *   'X', follower id                         that follower stopped answering
 *   'O','K' or 'O','K', id                   a follower pressed OK
 *
 * A 10-byte 'F' and a 5-byte 'M' are the older single-follower packets.
 * Those use follower id 0. A later counter byte does not clear a fix.
 */

/** 'G' plus fix byte plus two int32 microdegrees. */
export const GPS_PACKET_BYTES = 10;

/** 'F', id, fix, two int32 microdegrees. */
export const FOLLOWER_FIX_BYTES = 11;

/** 'M' plus uint32 centimeters, no id. */
export const SEPARATION_PACKET_BYTES = 5;

/** 'M', id, uint32 centimeters. */
export const SEPARATION_WITH_ID_BYTES = 6;

export interface GpsFix {
  fix: boolean;
  lat: number | null;
  lon: number | null;
}

export interface FollowerGpsFix extends GpsFix {
  id: number;
}

export interface Separation {
  known: boolean;
  meters: number | null;
}

export interface FollowerSeparation extends Separation {
  id: number;
}

export interface LiveNotify {
  counter: number | null;
  text: string | null;
  hex: string;
  follower: FollowerInfo | null;
  leaderBattery: number | null;
  /** Leader NEO-6M position, when this notify is a GPS packet. */
  gps: GpsFix | null;
  /** Follower NEO-6M position, when this notify is an F packet. */
  followerGps: FollowerGpsFix | null;
  /** Meters between the leader and that follower. */
  separation: FollowerSeparation | null;
  /** Board id from a 3-byte OK notify. Null when this notify is not that. */
  okId: number | null;
  /** Set when the leader drops a follower that stopped answering. */
  followerGoneId: number | null;
}

export function parseLiveNotify(bytes: Uint8Array): LiveNotify {
  const hex = bytesToHex(bytes);
  const base: LiveNotify = {
    counter: null,
    text: null,
    hex,
    follower: null,
    leaderBattery: null,
    gps: null,
    followerGps: null,
    separation: null,
    okId: null,
    followerGoneId: null,
  };

  if (bytes.length === 1) {
    return { ...base, counter: bytes[0] };
  }

  if (bytes.length === 4) {
    return { ...base, counter: uint32le(bytes) };
  }

  if (bytes.length >= FOLLOWER_PACKET_BYTES && bytes[0] === PACKET_VERSION) {
    try {
      return { ...base, follower: decodeFollower(bytes) };
    } catch {
      /* not a follower; try the other shapes below */
    }
  }

  if (bytes.length === 3 && bytes[0] === 0x4f && bytes[1] === 0x4b) {
    return { ...base, text: "OK", okId: bytes[2] };
  }

  if (bytes.length === 2 && bytes[0] === 0x58) {
    return { ...base, followerGoneId: bytes[1] };
  }

  if (bytes.length === GPS_PACKET_BYTES && bytes[0] === 0x47) {
    return { ...base, gps: decodeLatLon(bytes, 1) };
  }

  if (bytes.length === FOLLOWER_FIX_BYTES && bytes[0] === 0x46) {
    return { ...base, followerGps: { id: bytes[1], ...decodeLatLon(bytes, 2) } };
  }

  if (bytes.length === GPS_PACKET_BYTES && bytes[0] === 0x46) {
    return { ...base, followerGps: { id: 0, ...decodeLatLon(bytes, 1) } };
  }

  if (bytes.length === SEPARATION_WITH_ID_BYTES && bytes[0] === 0x4d) {
    return { ...base, separation: { id: bytes[1], ...decodeSeparation(bytes, 2) } };
  }

  if (bytes.length === SEPARATION_PACKET_BYTES && bytes[0] === 0x4d) {
    return { ...base, separation: { id: 0, ...decodeSeparation(bytes, 1) } };
  }

  if (bytes.length === LEADER_PACKET_BYTES && bytes[0] === PACKET_VERSION) {
    try {
      return { ...base, leaderBattery: decodeLeader(bytes).batteryPercent };
    } catch {
      /* fall through */
    }
  }

  return { ...base, text: decodeText(bytes) };
}

/** The leader notifies these two bytes after a follower LoRa packet says OK. */
export function isFollowerOkSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  const msg = text.trim().toUpperCase();
  return msg === "OK" || msg.startsWith("OK ");
}

/** One notification, as the events the dashboard already understands. */
export function eventsFromNotify(bytes: Uint8Array): BleEvent[] {
  const sample = parseLiveNotify(bytes);
  const events: BleEvent[] = [];
  if (sample.follower) {
    events.push({ type: "follower", info: sample.follower });
  } else if (sample.leaderBattery !== null && sample.counter == null) {
    events.push({ type: "leader", batteryPercent: sample.leaderBattery });
  }
  events.push({
    type: "live",
    counter: sample.counter,
    text: sample.text,
    hex: sample.hex,
    gps: sample.gps,
    followerGps: sample.followerGps,
    separation: sample.separation,
    okId: sample.okId,
    followerGoneId: sample.followerGoneId,
  });
  return events;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function decodeSeparation(bytes: Uint8Array, cmIndex: number): Separation {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cm = view.getUint32(cmIndex, true);
  if (cm === 0xffffffff) return { known: false, meters: null };
  return { known: true, meters: cm / 100 };
}

function decodeLatLon(bytes: Uint8Array, fixIndex: number): GpsFix {
  const locked = bytes[fixIndex] === 1;
  if (!locked) return { fix: false, lat: null, lon: null };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lat = view.getInt32(fixIndex + 1, true) / 1e7;
  const lon = view.getInt32(fixIndex + 5, true) / 1e7;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { fix: false, lat: null, lon: null };
  }
  return { fix: true, lat, lon };
}

function uint32le(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

function decodeText(bytes: Uint8Array): string | null {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0) end -= 1;
  if (end === 0) return null;
  for (let i = 0; i < end; i++) {
    const byte = bytes[i];
    const printable = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e);
    if (!printable) return null;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}
