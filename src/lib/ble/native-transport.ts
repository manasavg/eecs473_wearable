import { Capacitor } from "@capacitor/core";
import { eventsFromNotify } from "./live-link";
import { encodeCommand, viewToBytes } from "./protocol";
import type { BleEvent, BleTransport } from "./transport";
import type { AppCommand } from "./types";
import {
  ALERT_UUID,
  FOLLOWER_STATUS_UUID,
  LEADER_STATUS_UUID,
  BLE_NAME_PREFIX,
  LIVE_RX_UUID,
  LIVE_SERVICE_UUID,
  LIVE_TX_UUID,
} from "./uuids";

/**
 * Core Bluetooth link for the iPhone app.
 *
 * Safari has no Web Bluetooth, so this class runs inside the Capacitor shell,
 * not in the browser. The dashboard still talks to BleTransport. Notifications
 * are parsed by the same eventsFromNotify path Chrome uses.
 *
 * Build it on a Mac (the iOS simulator has no radio):
 *   npm run cap:sync
 *   npx cap open ios
 * In Xcode, add NSBluetoothAlwaysUsageDescription to Info.plist, pick your
 * iPhone, and run. See README.md, "iPhone".
 */

const RECONNECT_ATTEMPTS = 3;
const DEVICE_ID_KEY = "excursion.nativeDeviceId";
const DEVICE_NAME_KEY = "excursion.nativeDeviceName";

const DISPLAY = {
  scanning: `Looking for ${BLE_NAME_PREFIX}…`,
  cancel: "Cancel",
  availableDevices: "Beacons",
  noDeviceFound: `No ${BLE_NAME_PREFIX} in range. Is the ESP32 advertising?`,
};

interface GattProperties {
  read: boolean;
  write: boolean;
  writeWithoutResponse: boolean;
  notify: boolean;
  indicate: boolean;
}

interface GattCharacteristic {
  uuid: string;
  properties: GattProperties;
}

interface GattService {
  uuid: string;
  characteristics: GattCharacteristic[];
}

interface NativeDevice {
  deviceId: string;
  name?: string;
}

/**
 * The slice of @capacitor-community/bluetooth-le this app uses.
 * Tests pass a fake. The phone build uses BleClient.
 */
export interface NativeCentral {
  initialize(options?: { androidNeverForLocation?: boolean }): Promise<void>;
  isEnabled(): Promise<boolean>;
  setDisplayStrings?(strings: typeof DISPLAY): Promise<void>;
  requestDevice(options: {
    services?: string[];
    optionalServices?: string[];
    namePrefix?: string;
    displayMode?: "alert" | "list";
  }): Promise<NativeDevice>;
  getDevices(deviceIds: string[]): Promise<NativeDevice[]>;
  connect(
    deviceId: string,
    onDisconnect?: (deviceId: string) => void,
    options?: { timeout?: number; skipDescriptorDiscovery?: boolean },
  ): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  getServices(deviceId: string): Promise<GattService[]>;
  read(deviceId: string, service: string, characteristic: string): Promise<DataView>;
  write(deviceId: string, service: string, characteristic: string, value: DataView): Promise<void>;
  writeWithoutResponse(
    deviceId: string,
    service: string,
    characteristic: string,
    value: DataView,
  ): Promise<void>;
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
  ): Promise<void>;
  stopNotifications(deviceId: string, service: string, characteristic: string): Promise<void>;
}

export function isIosShell(): boolean {
  return Capacitor.getPlatform() === "ios";
}

export function rememberedNativeBeaconName(): string | null {
  return readStorage(DEVICE_NAME_KEY);
}

export class NativeBleTransport implements BleTransport {
  private listeners = new Set<(event: BleEvent) => void>();
  private central: NativeCentral | null = null;
  private deviceId: string | null = null;
  private deviceName = BLE_NAME_PREFIX;
  private writeTarget: { uuid: string; withoutResponse: boolean } | null = null;
  private wantLink = false;
  private reconnectsLeft = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private opening = false;

  constructor(private readonly injected?: NativeCentral) {}

  subscribe(listener: (event: BleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * @param remembered  Reconnect the last beacon without the device list.
   */
  async connect(remembered = false): Promise<void> {
    this.wantLink = true;
    const central = this.injected ?? (await loadCapacitorBle());
    this.central = central;
    try {
      await central.initialize({ androidNeverForLocation: true });
      if (!(await central.isEnabled())) {
        throw new Error("Bluetooth is off. Turn it on, then connect again.");
      }
      await central.setDisplayStrings?.(DISPLAY);
      const device = remembered ? await this.savedDevice(central) : await this.pickDevice(central);
      await this.open(central, device);
    } catch (error) {
      this.wantLink = false;
      throw explainBleError(error);
    }
  }

  async disconnect(): Promise<void> {
    this.wantLink = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const central = this.central;
    const deviceId = this.deviceId;
    this.writeTarget = null;
    this.deviceId = null;
    if (central && deviceId) {
      try {
        await central.disconnect(deviceId);
      } catch {
        /* the link is already gone */
      }
    }
    this.emit({ type: "disconnected", unexpected: false });
  }

  async writeCommand(command: AppCommand): Promise<void> {
    const central = this.central;
    const deviceId = this.deviceId;
    const target = this.writeTarget;
    if (!central || !deviceId || !target) {
      throw new Error("The beacon is not ready for commands yet.");
    }
    const payload = encodeCommand(command);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (target.withoutResponse) {
      await central.writeWithoutResponse(deviceId, LIVE_SERVICE_UUID, target.uuid, view);
      return;
    }
    await central.write(deviceId, LIVE_SERVICE_UUID, target.uuid, view);
  }

  private async pickDevice(central: NativeCentral): Promise<NativeDevice> {
    // This sketch calls getAdvertising()->start() without addServiceUUID, so
    // the packet only carries the name from BLEDevice::init("Leader_Device_LoRa").
    return central.requestDevice({
      namePrefix: BLE_NAME_PREFIX,
      optionalServices: [LIVE_SERVICE_UUID],
      displayMode: "list",
    });
  }

  private async savedDevice(central: NativeCentral): Promise<NativeDevice> {
    const deviceId = readStorage(DEVICE_ID_KEY);
    if (!deviceId) {
      throw new Error(`This phone has no saved beacon yet. Choose ${BLE_NAME_PREFIX} once.`);
    }
    const found = await central.getDevices([deviceId]);
    const device = found.find((item) => item.deviceId === deviceId);
    if (!device) {
      throw new Error(`The saved beacon is not available. Choose ${BLE_NAME_PREFIX} from the list.`);
    }
    return device;
  }

  private async open(central: NativeCentral, device: NativeDevice): Promise<void> {
    this.opening = true;
    this.deviceId = device.deviceId;
    this.deviceName = device.name || readStorage(DEVICE_NAME_KEY) || BLE_NAME_PREFIX;
    try {
      // The sketch notifies a counter as soon as the link is up. Waiting on
      // descriptor discovery then hits the plugin's 10s "Connection timeout".
      // Notifications do not need that discovery.
      if (!this.injected) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await central.connect(device.deviceId, () => this.handleDrop(), {
        timeout: 20000,
        skipDescriptorDiscovery: true,
      });
      const services = await central.getServices(device.deviceId);
      const service = services.find((item) => sameUuid(item.uuid, LIVE_SERVICE_UUID));
      if (!service) {
        throw new Error(
          `The phone is connected, but the beacon does not expose ${LIVE_SERVICE_UUID}.`,
        );
      }
      const tx = service.characteristics.find((item) => sameUuid(item.uuid, LIVE_TX_UUID));
      if (!tx) {
        throw new Error(
          `${BLE_NAME_PREFIX} is missing the notify characteristic ${LIVE_TX_UUID}.`,
        );
      }
      const rx = service.characteristics.find((item) => sameUuid(item.uuid, LIVE_RX_UUID));
      if (!rx) {
        throw new Error(
          `${BLE_NAME_PREFIX} is missing the write characteristic ${LIVE_RX_UUID}.`,
        );
      }
      this.writeTarget = {
        uuid: LIVE_RX_UUID,
        withoutResponse: rx.properties.writeWithoutResponse && !rx.properties.write,
      };

      await this.subscribeChar(central, device.deviceId, LIVE_TX_UUID);
      await this.subscribeIfPresent(central, device.deviceId, service, LEADER_STATUS_UUID);
      await this.subscribeIfPresent(central, device.deviceId, service, FOLLOWER_STATUS_UUID);
      await this.subscribeIfPresent(central, device.deviceId, service, ALERT_UUID);

      writeStorage(DEVICE_ID_KEY, device.deviceId);
      writeStorage(DEVICE_NAME_KEY, this.deviceName);
      this.reconnectsLeft = RECONNECT_ATTEMPTS;
      this.emit({ type: "connected", deviceName: this.deviceName });
    } finally {
      this.opening = false;
    }
  }

  private async subscribeIfPresent(
    central: NativeCentral,
    deviceId: string,
    service: GattService,
    uuid: string,
  ): Promise<void> {
    const found = service.characteristics.find((item) => sameUuid(item.uuid, uuid));
    if (!found || (!found.properties.notify && !found.properties.indicate)) return;
    await this.subscribeChar(central, deviceId, uuid);
  }

  private async subscribeChar(
    central: NativeCentral,
    deviceId: string,
    characteristic: string,
  ): Promise<void> {
    await central.startNotifications(deviceId, LIVE_SERVICE_UUID, characteristic, (value) => {
      this.onBytes(viewToBytes(value));
    });
  }

  private onBytes(bytes: Uint8Array): void {
    try {
      for (const event of eventsFromNotify(bytes)) this.emit(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bad packet from the beacon.";
      this.emit({ type: "error", message });
    }
  }

  private handleDrop(): void {
    this.writeTarget = null;
    if (!this.wantLink || !this.deviceId || !this.central || this.opening) return;
    if (this.reconnectsLeft <= 0) {
      this.emit({ type: "disconnected", unexpected: true });
      return;
    }
    this.reconnectsLeft -= 1;
    this.emit({ type: "reconnecting" });
    const central = this.central;
    const device = { deviceId: this.deviceId, name: this.deviceName };
    const waitMs = (RECONNECT_ATTEMPTS - this.reconnectsLeft) * 1000;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.wantLink) return;
      this.open(central, device).catch((error: unknown) => {
        this.emit({ type: "error", message: explainBleError(error).message });
        this.handleDrop();
      });
    }, waitMs);
  }

  private emit(event: BleEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function loadCapacitorBle(): Promise<NativeCentral> {
  const { BleClient } = await import("@capacitor-community/bluetooth-le");
  return BleClient;
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

const memoryStore = new Map<string, string>();

function readStorage(key: string): string | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem(key);
  } catch {
    /* private mode */
  }
  return memoryStore.get(key) ?? null;
}

function writeStorage(key: string, value: string): void {
  memoryStore.set(key, value);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function explainBleError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "Could not open the beacon.";
  if (/connection timeout/i.test(message)) {
    return new Error(
      `The phone found ${BLE_NAME_PREFIX}, then the link timed out. Reset the ESP32, keep it next to the phone, and connect again.`,
    );
  }
  if (/unsupported/i.test(message)) {
    return new Error("Bluetooth needs a real iPhone. The iOS simulator has no radio.");
  }
  if (/denied|unauthorized|permission/i.test(message)) {
    return new Error(
      "Bluetooth permission is off for Excursion. Enable it in Settings, then connect again.",
    );
  }
  return error instanceof Error ? error : new Error(message);
}
