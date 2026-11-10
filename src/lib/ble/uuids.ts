/**
 * Meshtastic Phone API over BLE. The Heltec runs Meshtastic firmware.
 * The phone writes ToRadio, reads FromRadio, and subscribes to FromNum.
 *
 *   Service    6ba1b218-15a8-461f-9fa8-5dcae273eafd
 *   ToRadio    f75c76d2-129e-4dad-a1dd-7866124401e7  write
 *   FromRadio  2c55e69e-4993-11ed-b878-0242ac120002  read
 *   FromNum    ed9da18c-a800-4f66-a670-aa7547e34453  notify
 */

export const BLE_NAME_PREFIX = "Meshtastic";

/** Mesh service advertised by the Meshtastic firmware. */
export const LIVE_SERVICE_UUID = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";

/** ToRadio. PROPERTY_WRITE. One ToRadio protobuf per write. */
export const LIVE_RX_UUID = "f75c76d2-129e-4dad-a1dd-7866124401e7";

/** FromNum. PROPERTY_NOTIFY. A 4-byte counter. The payload is read from FromRadio. */
export const LIVE_TX_UUID = "ed9da18c-a800-4f66-a670-aa7547e34453";

/** FromRadio. PROPERTY_READ. One FromRadio protobuf per read. Empty means the queue is drained. */
export const FROM_RADIO_UUID = "2c55e69e-4993-11ed-b878-0242ac120002";

/** Older name for the write characteristic. */
export const LIVE_DATA_UUID = LIVE_RX_UUID;

/** Same service the chooser and GATT browser open. */
export const EXCURSION_SERVICE_UUID = LIVE_SERVICE_UUID;

const UUID_TAIL = "0000-4000-8000-657863757273";

/**
 * TODO(ble): Add these to the ESP32 service when wristbands, beacon battery,
 * and alerts leave the demo. Until then the phone does not require them.
 */
export const LEADER_STATUS_UUID = `47300002-${UUID_TAIL}`;
export const FOLLOWER_STATUS_UUID = `47300003-${UUID_TAIL}`;
export const ALERT_UUID = `47300004-${UUID_TAIL}`;
export const COMMAND_UUID = `47300005-${UUID_TAIL}`;

const NAME_KEY = "excursion.bleNamePrefix";
/** Names from earlier sketches. A saved copy of these must not hide the Heltec board. */
const RETIRED_PREFIXES = ["Excursion", "Leader_Device", "Leader_Device_LoRa"];

export function getBleNamePrefix(): string {
  try {
    if (typeof localStorage === "undefined") return BLE_NAME_PREFIX;
    const stored = localStorage.getItem(NAME_KEY)?.trim();
    if (!stored || RETIRED_PREFIXES.includes(stored)) return BLE_NAME_PREFIX;
    return stored;
  } catch {
    return BLE_NAME_PREFIX;
  }
}

export function setBleNamePrefix(name: string): void {
  const trimmed = name.trim().slice(0, 29);
  try {
    if (!trimmed || trimmed === BLE_NAME_PREFIX || RETIRED_PREFIXES.includes(trimmed)) {
      localStorage.removeItem(NAME_KEY);
      return;
    }
    localStorage.setItem(NAME_KEY, trimmed);
  } catch {
    /* private mode */
  }
}
