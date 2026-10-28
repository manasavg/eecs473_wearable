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
 * Bytes from the ESP32 sketch in firmware/leader_device/leader_device.ino.
 *
 * The TX characteristic notifies one uint8 every 3 seconds, a 10-byte GPS
 * packet when the leader NEO-6M emits RMC or GGA, and a 5-byte distance
 * packet after the follower's position arrives over LoRa:
 *
 *   'G', fix (0 or 1), int32 latitude * 1e7, int32 longitude * 1e7
 *   'F', fix (0 or 1), int32 latitude * 1e7, int32 longitude * 1e7
 *   'M', uint32 centimeters, little-endian. 0xFFFFFFFF means no distance.
 *
 * Both integers are little-endian. A fix byte of 0 means the module has
 * not locked. A later counter byte does not clear the last fix or distance.
 *
 * A 1-byte notification is that counter. A 4-byte notification is still read
 * as a little-endian uint32 so an older counter does not look like an alert.
 * Alerts stay on ALERT_UUID once that characteristic exists.
 *
 * A 9-byte version-1 notification is a follower, so the same characteristic
 * can start carrying wristbands without another app change.
 */

/** 'G' or 'F' plus fix byte plus two int32 microdegrees. */
export const GPS_PACKET_BYTES = 10;

/** 'M' plus uint32 centimeters. */
export const SEPARATION_PACKET_BYTES = 5;

export interface GpsFix {
  fix: boolean;
  lat: number | null;
  lon: number | null;
}

export interface Separation {
  known: boolean;
  meters: number | null;
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
  followerGps: GpsFix | null;
  /** Meters between the two GPS fixes, when this notify is a distance packet. */
  separation: Separation | null;
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

  if (bytes.length === GPS_PACKET_BYTES && bytes[0] === 0x47) {
    return { ...base, gps: decodeLatLon(bytes) };
  }

  if (bytes.length === GPS_PACKET_BYTES && bytes[0] === 0x46) {
    return { ...base, followerGps: decodeLatLon(bytes) };
  }

  if (bytes.length === SEPARATION_PACKET_BYTES && bytes[0] === 0x4d) {
    return { ...base, separation: decodeSeparation(bytes) };
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
  });
  return events;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function decodeSeparation(bytes: Uint8Array): Separation {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cm = view.getUint32(1, true);
  if (cm === 0xffffffff) return { known: false, meters: null };
  return { known: true, meters: cm / 100 };
}

function decodeLatLon(bytes: Uint8Array): GpsFix {
  const locked = bytes[1] === 1;
  if (!locked) return { fix: false, lat: null, lon: null };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lat = view.getInt32(2, true) / 1e7;
  const lon = view.getInt32(6, true) / 1e7;
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
