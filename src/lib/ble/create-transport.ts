import { MockTrailTransport } from "./mock-transport";
import type { BleTransport } from "./transport";
import { WebBluetoothTransport } from "./web-bluetooth-transport";

export type LinkMode = "demo" | "beacon";

/**
 * TODO(ble): This is the switch for the phone link.
 *   "demo"   — stand-in trail, no radio
 *   "beacon" — Web Bluetooth (Chrome on Android and desktop)
 * When the iOS shell exists, return the native transport from
 * native-transport.todo.ts for that build. The UI does not change.
 */
export function createTransport(mode: LinkMode): BleTransport {
  if (mode === "demo") return new MockTrailTransport();
  return new WebBluetoothTransport();
}
