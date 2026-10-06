/**
 * GATT map for the ESP32 sketch in firmware/leader_device/leader_device.ino.
 * The phone is the central. That sketch is the peripheral.
 *
 *   BLEDevice::init("Leader_Device");
 *   SERVICE_UUID        2b30c8ab-64a1-4c5d-a8fc-3089a210b8f1
 *   CHARACTERISTIC_UUID 017b6e07-c0b7-411a-8c8b-e54cb2fcf2b8
 *
 * The characteristic is read, write, notify, and indicate. setup() stores
 * "Data successfully transmitted". loop() notifies a little-endian uint32
 * every 500 ms while the phone is connected.
 *
 * Appendix C characteristic UUIDs below are not on that sketch. The transport
 * subscribes to them only when the ESP32 adds them to this same service.
 * Wristband bytes can also arrive on LIVE_DATA_UUID; see live-link.ts.
 */

export const BLE_NAME_PREFIX = "Leader_Device";

/** Service advertised by the flashed sketch. */
export const LIVE_SERVICE_UUID = "2b30c8ab-64a1-4c5d-a8fc-3089a210b8f1";

/** The one characteristic the flashed sketch exposes. */
export const LIVE_DATA_UUID = "017b6e07-c0b7-411a-8c8b-e54cb2fcf2b8";

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
/** Previous default, before the sketch name was wired in. Ignore it if saved. */
const RETIRED_PREFIX = "Excursion";

export function getBleNamePrefix(): string {
  try {
    if (typeof localStorage === "undefined") return BLE_NAME_PREFIX;
    const stored = localStorage.getItem(NAME_KEY)?.trim();
    if (!stored || stored === RETIRED_PREFIX) return BLE_NAME_PREFIX;
    return stored;
  } catch {
    return BLE_NAME_PREFIX;
  }
}

export function setBleNamePrefix(name: string): void {
  const trimmed = name.trim().slice(0, 29);
  try {
    if (!trimmed || trimmed === BLE_NAME_PREFIX || trimmed === RETIRED_PREFIX) {
      localStorage.removeItem(NAME_KEY);
      return;
    }
    localStorage.setItem(NAME_KEY, trimmed);
  } catch {
    /* private mode */
  }
}
