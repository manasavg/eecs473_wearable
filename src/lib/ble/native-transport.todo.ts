/**
 * TODO(ble): iPhone build.
 *
 * Web Bluetooth does not exist in Safari, and the proposal needs both
 * iOS and Android. The dashboard and the byte codec stay as they are.
 * Implement `BleTransport` (see transport.ts) with a native BLE stack and
 * return it from createTransport() for that build.
 *
 * Suggested stack: React Native, or Capacitor around this Next app, plus
 * `react-native-ble-plx`. Do not re-encode packets here. Call the functions
 * in protocol.ts so the ESP32 sees the same bytes Chrome sends.
 *
 * Sketch — fill these in when the native project exists:
 *
 *   import { BleManager } from "react-native-ble-plx";
 *   import { encodeCommand, decodeFollower, decodeLeader, decodeAlert } from "./protocol";
 *   import { EXCURSION_SERVICE_UUID, FOLLOWER_STATUS_UUID, LEADER_STATUS_UUID, ALERT_UUID, COMMAND_UUID } from "./uuids";
 *
 *   TODO(ble): const manager = new BleManager();
 *   TODO(ble): manager.startDeviceScan([EXCURSION_SERVICE_UUID], null, (error, device) => {
 *                // Match device.name against getBleNamePrefix(), then stop the scan.
 *              });
 *   TODO(ble): await device.connect({ timeout: 8000 });
 *   TODO(ble): await device.discoverAllServicesAndCharacteristics();
 *   TODO(ble): device.monitorCharacteristicForService(EXCURSION_SERVICE_UUID, FOLLOWER_STATUS_UUID, (error, ch) => {
 *                const info = decodeFollower(base64ToBytes(ch.value));
 *              });
 *   TODO(ble): Same monitor for LEADER_STATUS_UUID → decodeLeader, and ALERT_UUID → decodeAlert.
 *   TODO(ble): device.writeCharacteristicWithoutResponseForService(
 *                EXCURSION_SERVICE_UUID,
 *                COMMAND_UUID,
 *                bytesToBase64(encodeCommand(command)),
 *              );
 *   TODO(ble): Bonding / LE Secure Connections is required on the ESP32.
 *              Do not write a command on a link the OS reports as unencrypted.
 *   TODO(ble): On unexpected disconnect, retry device.connect() a few times,
 *              then surface "Beacon link dropped" the same way WebBluetoothTransport does.
 *
 * Keep the UI on `ExcursionAppClient`. It already speaks BleTransport and
 * does not know which radio stack is underneath.
 */

export const NATIVE_BLE_TODO =
  "iOS transport is not wired. Implement BleTransport in this file, then return it from createTransport().";
