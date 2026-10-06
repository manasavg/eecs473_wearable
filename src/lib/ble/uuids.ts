/**
 * Provisional GATT map for the leader beacon (ESP32, BLE peripheral).
 * The phone is the central. Nothing else in the app hardcodes these values.
 *
 * TODO(ble): Paste the ESP32's real 128-bit UUIDs here if firmware generates its own.
 * TODO(ble): Set BLE_NAME_PREFIX to the exact name the module advertises.
 *            "Excursion" matches a beacon that advertises "Excursion-Leader".
 *            You can also change the name from the Beacon link sheet without a rebuild;
 *            that override is stored on this phone only.
 */

export const BLE_NAME_PREFIX = "Excursion";

const UUID_TAIL = "0000-4000-8000-657863757273";

/** Custom service. 0x4730 is a mnemonic for EECS 473, not a Bluetooth SIG id. */
export const EXCURSION_SERVICE_UUID = `47300001-${UUID_TAIL}`;

/** Notify + read. Leader beacon battery. There is no LED on the beacon itself. */
export const LEADER_STATUS_UUID = `47300002-${UUID_TAIL}`;

/** Notify. One packet per wristband: id, status, battery, distance, angle, flags. */
export const FOLLOWER_STATUS_UUID = `47300003-${UUID_TAIL}`;

/** Notify. Edge-triggered lost-hiker / need-help / out-of-range events. */
export const ALERT_UUID = `47300004-${UUID_TAIL}`;

/** Write. Check-in and separation-line commands from the phone. */
export const COMMAND_UUID = `47300005-${UUID_TAIL}`;

const NAME_KEY = "excursion.bleNamePrefix";

export function getBleNamePrefix(): string {
  try {
    if (typeof localStorage === "undefined") return BLE_NAME_PREFIX;
    const stored = localStorage.getItem(NAME_KEY)?.trim();
    return stored || BLE_NAME_PREFIX;
  } catch {
    return BLE_NAME_PREFIX;
  }
}

export function setBleNamePrefix(name: string): void {
  const trimmed = name.trim().slice(0, 29);
  try {
    if (!trimmed || trimmed === BLE_NAME_PREFIX) {
      localStorage.removeItem(NAME_KEY);
      return;
    }
    localStorage.setItem(NAME_KEY, trimmed);
  } catch {
    /* private mode */
  }
}
