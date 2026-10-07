import { eventsFromNotify } from "./live-link";
import { decodeAlert, decodeFollower, decodeLeader, encodeCommand, viewToBytes } from "./protocol";
import type { BleEvent, BleTransport } from "./transport";
import type { AppCommand } from "./types";
import { Status } from "./types";
import {
  ALERT_UUID,
  FOLLOWER_STATUS_UUID,
  LEADER_STATUS_UUID,
  BLE_NAME_PREFIX,
  LIVE_RX_UUID,
  LIVE_SERVICE_UUID,
  LIVE_TX_UUID,
  getBleNamePrefix,
} from "./uuids";

/**
 * Web Bluetooth link to the leader beacon.
 *
 * The beacon is the BLE peripheral (ESP32). This phone is the central.
 * Chrome on Android and desktop Chromium implement this API.
 * Safari on iPhone does not — use native-transport.todo.ts for that build.
 *
 * The flashed sketch (firmware/leader_device/leader_device.ino) has one
 * service and one characteristic. Notifications from that characteristic
 * are parsed in live-link.ts. Appendix C characteristics are subscribed
 * only when the ESP32 has added them to the same service.
 */

const RECONNECT_ATTEMPTS = 3;

export function webBluetoothAvailable(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

export class WebBluetoothTransport implements BleTransport {
  private listeners = new Set<(event: BleEvent) => void>();
  private device: BluetoothDevice | null = null;
  private command: BluetoothRemoteGATTCharacteristic | null = null;
  private wantLink = false;
  private reconnectsLeft = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private opening = false;

  private readonly onGattDisconnected = () => {
    this.handleDrop();
  };

  subscribe(listener: (event: BleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * @param remembered  Use a device this browser already permitted, skipping the chooser.
   *                    requestDevice() itself must run in the click that called connect().
   */
  async connect(remembered = false): Promise<void> {
    if (!webBluetoothAvailable()) {
      throw new Error(
        "This browser cannot open Bluetooth. Chrome on Android can reach the beacon. The demo group works everywhere.",
      );
    }

    this.wantLink = true;
    const prefix = getBleNamePrefix();

    let device: BluetoothDevice;
    if (remembered) {
      const permitted = await rememberDevice(prefix);
      if (!permitted) {
        throw new Error(
          "This browser has no saved beacon yet. Choose it once from the Bluetooth list.",
        );
      }
      device = permitted;
    } else {
      try {
        device = await navigator.bluetooth.requestDevice({
          // The sketch advertises the name only. It does not call addServiceUUID,
          // so a service filter by itself would hide Leader_Device_LoRa.
          filters: [
            { namePrefix: BLE_NAME_PREFIX },
            ...(prefix === BLE_NAME_PREFIX ? [] : [{ namePrefix: prefix }]),
          ],
          optionalServices: [LIVE_SERVICE_UUID],
        });
      } catch (error) {
        this.wantLink = false;
        throw new Error(explainRequestError(error, prefix));
      }
    }

    this.attach(device);
    try {
      await this.openGatt(device);
    } catch (error) {
      this.detach();
      this.wantLink = false;
      throw error instanceof Error ? error : new Error("Could not open the beacon.");
    }
  }

  async disconnect(): Promise<void> {
    this.wantLink = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const device = this.device;
    this.detach();
    device?.gatt?.disconnect();
    this.emit({ type: "disconnected", unexpected: false });
  }

  async writeCommand(command: AppCommand): Promise<void> {
    const characteristic = this.command;
    if (!characteristic) {
      throw new Error("The beacon is not ready for commands yet.");
    }
    const payload = encodeCommand(command);
    // Web Bluetooth's BufferSource type is narrower than Uint8Array's generic.
    const wire = payload as BufferSource;

    // TODO(ble): Write-without-response keeps a check-in off the ranging window.
    // Enable that property on the ESP32 command characteristic. If it is missing,
    // we fall back to a write with response.
    if (characteristic.properties.writeWithoutResponse) {
      await characteristic.writeValueWithoutResponse(wire);
      return;
    }
    if (characteristic.properties.write) {
      await characteristic.writeValueWithResponse(wire);
      return;
    }
    throw new Error(
      "The command characteristic is not writable. Check the ESP32 GATT permissions.",
    );
  }

  private attach(device: BluetoothDevice): void {
    this.detach();
    this.device = device;
    device.addEventListener("gattserverdisconnected", this.onGattDisconnected);
  }

  private detach(): void {
    this.device?.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
    this.device = null;
    this.command = null;
  }

  private async openGatt(device: BluetoothDevice): Promise<void> {
    if (!device.gatt) {
      throw new Error("This Bluetooth device has no GATT server.");
    }
    this.opening = true;
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(LIVE_SERVICE_UUID).catch(() => {
        throw new Error(
          `The device is connected, but it does not expose ${LIVE_SERVICE_UUID}. That is the service in firmware/leader_device.`,
        );
      });

      const tx = await characteristic(service, LIVE_TX_UUID, "notify");
      const rx = await characteristic(service, LIVE_RX_UUID, "write");
      this.command = rx;

      // TODO(ble): Pairing is done by the phone OS, not by this file.
      // The current sketch does not require a bond. Before a hike, require
      // LE Secure Connections so a nearby phone cannot write this characteristic.

      await this.listen(tx, (bytes) => this.emitSample(bytes));

      // TODO(ble): Present only after the ESP32 adds them to LIVE_SERVICE_UUID.
      await this.listenIfPresent(service, LEADER_STATUS_UUID, (bytes) => {
        const status = decodeLeader(bytes);
        this.emit({ type: "leader", batteryPercent: status.batteryPercent });
      });
      await this.listenIfPresent(service, FOLLOWER_STATUS_UUID, (bytes) => {
        this.emit({ type: "follower", info: decodeFollower(bytes) });
      });
      await this.listenIfPresent(service, ALERT_UUID, (bytes) => {
        const notice = decodeAlert(bytes);
        this.emit({
          type: "alert",
          deviceId: notice.deviceId,
          status: notice.status,
          uwbOutOfRange: notice.uwbOutOfRange,
        });
      });

      this.reconnectsLeft = RECONNECT_ATTEMPTS;
      this.emit({
        type: "connected",
        deviceName: device.name || "Leader beacon",
      });
    } finally {
      this.opening = false;
    }
  }

  private emitSample(bytes: Uint8Array): void {
    for (const event of eventsFromNotify(bytes)) this.emit(event);
  }

  private async listenIfPresent(
    service: BluetoothRemoteGATTService,
    uuid: string,
    onPacket: (bytes: Uint8Array) => void,
  ): Promise<void> {
    const found = await optionalCharacteristic(service, uuid);
    if (!found) return;
    await this.listen(found, onPacket);
  }

  private async listen(
    characteristic: BluetoothRemoteGATTCharacteristic,
    onPacket: (bytes: Uint8Array) => void,
  ): Promise<void> {
    await characteristic.startNotifications();
    characteristic.addEventListener("characteristicvaluechanged", () => {
      if (!characteristic.value) return;
      try {
        onPacket(viewToBytes(characteristic.value));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bad packet from the beacon.";
        this.emit({ type: "error", message });
      }
    });
  }

  private handleDrop(): void {
    this.command = null;
    if (!this.wantLink || !this.device || this.opening) return;

    // TODO(ble): Trail reconnect policy. Three attempts, then the leader taps
    // Connect again. gatt.connect() does not need a new chooser; requestDevice does.
    if (this.reconnectsLeft <= 0) {
      this.emit({ type: "disconnected", unexpected: true });
      return;
    }
    this.reconnectsLeft -= 1;
    this.emit({ type: "reconnecting" });
    const device = this.device;
    const waitMs = (RECONNECT_ATTEMPTS - this.reconnectsLeft) * 1000;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.wantLink) return;
      this.openGatt(device).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Reconnect failed.";
        this.emit({ type: "error", message });
        this.handleDrop();
      });
    }, waitMs);
  }

  private emit(event: BleEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export async function rememberedBeaconName(): Promise<string | null> {
  if (!webBluetoothAvailable()) return null;
  try {
    const device = await rememberDevice(getBleNamePrefix());
    return device?.name ?? null;
  } catch {
    return null;
  }
}

async function rememberDevice(prefix: string): Promise<BluetoothDevice | null> {
  if (!navigator.bluetooth.getDevices) return null;
  const devices = await navigator.bluetooth.getDevices();
  return (
    devices.find((device) => (device.name ?? "").startsWith(prefix)) ?? devices[0] ?? null
  );
}

async function characteristic(
  service: BluetoothRemoteGATTService,
  uuid: string,
  label: string,
): Promise<BluetoothRemoteGATTCharacteristic> {
  try {
    return await service.getCharacteristic(uuid);
  } catch {
    throw new Error(
      `${BLE_NAME_PREFIX} is missing the ${label} characteristic (${uuid}). That UUID is in firmware/leader_device.`,
    );
  }
}

async function optionalCharacteristic(
  service: BluetoothRemoteGATTService,
  uuid: string,
): Promise<BluetoothRemoteGATTCharacteristic | null> {
  try {
    return await service.getCharacteristic(uuid);
  } catch {
    return null;
  }
}

function explainRequestError(error: unknown, prefix: string): string {
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return `No beacon chosen. If the list was empty, the ESP32 is not advertising as “${prefix}”. The sketch uses ${BLE_NAME_PREFIX}.`;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Could not open the Bluetooth chooser.";
}

export function isEmergencyStatus(status: Status): status is Status.NEED_HELP | Status.OUT_OF_RANGE {
  return status === Status.NEED_HELP || status === Status.OUT_OF_RANGE;
}
