import { BROADCAST_ID } from "./constants";
import { MeshLink } from "../meshtastic/link";
import type { BoardPlan } from "../meshtastic/setup";
import { viewToBytes } from "./protocol";
import type { BleEvent, BleTransport } from "./transport";
import type { AppCommand } from "./types";
import { CmdType, Status } from "./types";
import {
  BLE_NAME_PREFIX,
  FROM_RADIO_UUID,
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
  private fromRadio: BluetoothRemoteGATTCharacteristic | null = null;
  private link: MeshLink | null = null;
  private draining = false;
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
          filters: [
            { services: [LIVE_SERVICE_UUID] },
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

  async setUpBoard(plan: BoardPlan): Promise<void> {
    if (!this.link) throw new Error("Connect a board first.");
    await this.link.setUpBoard(plan);
  }

  async writeCommand(command: AppCommand): Promise<void> {
    if (command.type !== CmdType.CHECK_IN) return;
    const characteristic = this.command;
    if (!characteristic) {
      throw new Error("The beacon is not ready for commands yet.");
    }
    if (!this.link) throw new Error("The beacon is not ready for commands yet.");
    const targets =
      command.targetId === BROADCAST_ID ? this.link.knownNodes() : [command.targetId];
    if (targets.length === 0) throw new Error("The leader has not heard any other board yet.");
    for (const target of targets) await this.link.sendCheckIn(target);
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
    this.fromRadio = null;
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

      const fromNum = await characteristic(service, LIVE_TX_UUID, "FromNum");
      const toRadio = await characteristic(service, LIVE_RX_UUID, "ToRadio");
      this.fromRadio = await characteristic(service, FROM_RADIO_UUID, "FromRadio");
      this.command = toRadio;
      this.link = new MeshLink(
        async (bytes) => {
          const wire = new Uint8Array(bytes) as BufferSource;
          if (toRadio.properties.write) {
            await toRadio.writeValueWithResponse(wire);
            return;
          }
          if (toRadio.properties.writeWithoutResponse) {
            await toRadio.writeValueWithoutResponse(wire);
            return;
          }
          throw new Error("ToRadio is not writable.");
        },
        (event) => this.emit(event),
      );

      await this.listen(fromNum, () => {
        void this.drain();
      });
      this.reconnectsLeft = RECONNECT_ATTEMPTS;
      this.emit({
        type: "connected",
        deviceName: device.name || BLE_NAME_PREFIX,
      });
      await this.link.configure();
      await this.drain();
    } finally {
      this.opening = false;
    }
  }

  private async drain(): Promise<void> {
    const fromRadio = this.fromRadio;
    if (!fromRadio || this.draining) return;
    this.draining = true;
    try {
      for (let n = 0; n < 40; n++) {
        let bytes: Uint8Array;
        try {
          bytes = viewToBytes(await fromRadio.readValue());
        } catch {
          break;
        }
        if (bytes.length === 0) break;
        this.link?.push(bytes);
      }
    } finally {
      this.draining = false;
    }
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

function explainRequestError(error: unknown, prefix: string): string {
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return `No board chosen. If the list was empty, the Heltec is not advertising as “${prefix}”.`;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Could not open the Bluetooth chooser.";
}

export function isEmergencyStatus(status: Status): status is Status.NEED_HELP | Status.OUT_OF_RANGE {
  return status === Status.NEED_HELP || status === Status.OUT_OF_RANGE;
}
