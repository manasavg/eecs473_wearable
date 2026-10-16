/**
 * GATT map for the ESP32 sketch in firmware/leader_device/leader_device.ino.
 * The phone is the central. That sketch is the peripheral.
 *
 *   BLEDevice::init("Leader_Device_LoRa");
 *   SERVICE_UUID           20b723dd-215e-4424-bd75-746a902408bb
 *   CHARACTERISTIC_UUID_RX 0be48bf3-86c4-4d13-8e2c-2ac0a569817c  write
 *   CHARACTERISTIC_UUID_TX 209989cd-1fc7-4eb1-979e-690ba55053da  notify
 *
 * setup() does not add the service UUID to the advertising packet. The phone
 * finds the name Leader_Device_LoRa, then opens this service. loop() notifies
 * one uint8 on TX every 3 seconds. onWrite on RX treats a first byte of 1 as
 * the flag that transmits LoRa "CHECK IN".
 *
 * Appendix C characteristic UUIDs below are not on that sketch. The transport
 * subscribes to them only when the ESP32 adds them to this same service.
 */

export const BLE_NAME_PREFIX = "Leader_Device_LoRa";

/** Service created by the flashed sketch. It is not in the advertising packet. */
export const LIVE_SERVICE_UUID = "20b723dd-215e-4424-bd75-746a902408bb";

/** RX. PROPERTY_WRITE. A first byte of 1 makes the sketch send LoRa "CHECK IN". */
export const LIVE_RX_UUID = "0be48bf3-86c4-4d13-8e2c-2ac0a569817c";

/** TX. PROPERTY_NOTIFY. One uint8, incremented every 3 seconds. */
export const LIVE_TX_UUID = "209989cd-1fc7-4eb1-979e-690ba55053da";

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
const RETIRED_PREFIXES = ["Excursion", "Leader_Device"];

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
