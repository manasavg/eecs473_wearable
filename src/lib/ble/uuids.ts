/**
 * GATT map for the ESP32 sketch in firmware/leader_device/leader_device.ino.
 * The phone is the central. That sketch is the peripheral.
 *
 *   BLEDevice::init("Leader_Device");
 *   SERVICE_UUID           2b30c8ab-64a1-4c5d-a8fc-3089a210b8f1
 *   CHARACTERISTIC_UUID_RX 017b6e07-c0b7-411a-8c8b-e54cb2fcf2b8  write
 *   CHARACTERISTIC_UUID_TX 812f1d0a-031f-4bf3-8c40-0c8f27971552  notify
 *
 * setup() does not add the service UUID to the advertising packet. The phone
 * finds the name Leader_Device, then opens this service. loop() notifies one
 * uint8 on TX every 3 seconds. onWrite on RX prints the bytes.
 *
 * Appendix C characteristic UUIDs below are not on that sketch. The transport
 * subscribes to them only when the ESP32 adds them to this same service.
 */

export const BLE_NAME_PREFIX = "Leader_Device";

/** Service created by the flashed sketch. It is not in the advertising packet. */
export const LIVE_SERVICE_UUID = "2b30c8ab-64a1-4c5d-a8fc-3089a210b8f1";

/** RX. PROPERTY_WRITE. The sketch prints these bytes from onWrite. */
export const LIVE_RX_UUID = "017b6e07-c0b7-411a-8c8b-e54cb2fcf2b8";

/** TX. PROPERTY_NOTIFY. One uint8, incremented every 3 seconds. */
export const LIVE_TX_UUID = "812f1d0a-031f-4bf3-8c40-0c8f27971552";

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
