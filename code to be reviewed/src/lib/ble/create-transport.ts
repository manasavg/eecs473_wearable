import { Capacitor } from "@capacitor/core";
import { NativeBleTransport } from "./native-transport";
import type { BleTransport } from "./transport";
import { WebBluetoothTransport } from "./web-bluetooth-transport";

export type LinkMode = "beacon";

export function isNativeShell(): boolean {
  return Capacitor.isNativePlatform();
}

export function createTransport(mode: LinkMode): BleTransport {
  if (mode === "beacon" && isNativeShell()) return new NativeBleTransport();
  return new WebBluetoothTransport();
}
