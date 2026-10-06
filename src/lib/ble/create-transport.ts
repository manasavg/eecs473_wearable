import { Capacitor } from "@capacitor/core";
import { MockTrailTransport } from "./mock-transport";
import { NativeBleTransport } from "./native-transport";
import type { BleTransport } from "./transport";
import { WebBluetoothTransport } from "./web-bluetooth-transport";

export type LinkMode = "demo" | "beacon";

/**
 *   "demo"   — stand-in trail, no radio
 *   "beacon" — Core Bluetooth inside the iPhone app, otherwise Web Bluetooth
 */
export function isNativeShell(): boolean {
  return Capacitor.isNativePlatform();
}

export function createTransport(mode: LinkMode): BleTransport {
  if (mode === "demo") return new MockTrailTransport();
  if (isNativeShell()) return new NativeBleTransport();
  return new WebBluetoothTransport();
}
