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
 * The TX characteristic notifies one uint8 every 3 seconds, and a 3-byte
 * distance packet (`D` + uint16 centimeters, little-endian) when the UWB
 * anchor reports a filtered range:
 *
 *   pTxCharacteristic->setValue(&txValue, 1);
 *   pTxCharacteristic->notify();
 *   txValue++;
 *
 * A 1-byte notification is that counter. A 4-byte notification is still read
 * as a little-endian uint32 so an older counter does not look like an alert.
 * Alerts stay on ALERT_UUID once that characteristic exists.
 *
 * A 9-byte version-1 notification is a follower, so the same characteristic
 * can start carrying wristbands without another app change.
 */

export interface LiveNotify {
  counter: number | null;
  text: string | null;
  hex: string;
  follower: FollowerInfo | null;
  leaderBattery: number | null;
  /** Meters between the UWB anchor and tag, when this notify is a distance packet. */
  distanceM: number | null;
}

export function parseLiveNotify(bytes: Uint8Array): LiveNotify {
  const hex = bytesToHex(bytes);
  const base: LiveNotify = {
    counter: null,
    text: null,
    hex,
    follower: null,
    leaderBattery: null,
    distanceM: null,
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

  // 'D' + uint16 centimeters, little-endian. The leader sends this when the
  // UWB anchor reports a filtered range.
  if (bytes.length === 3 && bytes[0] === 0x44) {
    const cm = bytes[1] | (bytes[2] << 8);
    return { ...base, distanceM: cm / 100 };
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
    distanceM: sample.distanceM,
  });
  return events;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
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
