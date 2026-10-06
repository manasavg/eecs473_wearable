import { PACKET_VERSION } from "./constants";
import {
  FOLLOWER_PACKET_BYTES,
  LEADER_PACKET_BYTES,
  decodeFollower,
  decodeLeader,
} from "./protocol";
import type { FollowerInfo } from "./types";

/**
 * Bytes from the ESP32 sketch that is already paired to the phone.
 *
 * setup() stores the text "Data successfully transmitted".
 * loop(), while connected, notifies a little-endian uint32 every 500 ms:
 *
 *   pCharacteristic->setValue((uint8_t *)&value, 4);
 *   pCharacteristic->notify();
 *   value++;
 *
 * A 4-byte notification is that counter. It is not an alert packet, even
 * though both are 4 bytes. Alerts stay on ALERT_UUID once that characteristic
 * exists.
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
}

export function parseLiveNotify(bytes: Uint8Array): LiveNotify {
  const hex = bytesToHex(bytes);
  const base: LiveNotify = {
    counter: null,
    text: null,
    hex,
    follower: null,
    leaderBattery: null,
  };

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

  if (bytes.length === LEADER_PACKET_BYTES && bytes[0] === PACKET_VERSION) {
    try {
      return { ...base, leaderBattery: decodeLeader(bytes).batteryPercent };
    } catch {
      /* fall through */
    }
  }

  return { ...base, text: decodeText(bytes) };
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
