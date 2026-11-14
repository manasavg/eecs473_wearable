import { BROADCAST_ID } from "./constants";
import { Capacitor } from "@capacitor/core";
import { MeshLink } from "../meshtastic/link";
import { viewToBytes } from "./protocol";
import type { BleEvent, BlePeer, BleTransport } from "./transport";
import type { AppCommand } from "./types";
import { CmdType } from "./types";
import {
  BLE_NAME_PREFIX,
  FROM_RADIO_UUID,
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

/**
 * initialize() builds a new iOS Bluetooth controller. Calling it again after a
 * scan drops the boards that scan found, and connect then waits until timeout.
 * One controller per central for the life of the page.
 */
const preparedCentrals = new WeakSet<object>();

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

interface NativeScanResult {
  device: NativeDevice;
  localName?: string;
  uuids?: string[];
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
  requestLEScan?(
    options: {
      services?: string[];
      namePrefix?: string;
      optionalServices?: string[];
      allowDuplicates?: boolean;
    },
    callback: (result: NativeScanResult) => void,
  ): Promise<void>;
  stopLEScan?(): Promise<void>;
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
  private link: MeshLink | null = null;
  private draining = false;
  private drainAgain = false;

  constructor(private readonly injected?: NativeCentral) {}

  subscribe(listener: (event: BleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Report every board advertising Excursion_. Does not connect.
   * Call stopScan before connecting, or the phone drops the new link.
   */
  async scan(onPeer: (peer: BlePeer) => void): Promise<void> {
    const central = this.injected ?? (await loadCapacitorBle());
    this.central = central;
    await prepareCentral(central);
    await central.setDisplayStrings?.(DISPLAY);
    await central.stopLEScan?.().catch(() => undefined);
    if (!central.requestLEScan) {
      const device = await central.requestDevice({
        services: [LIVE_SERVICE_UUID],
        namePrefix: BLE_NAME_PREFIX,
        displayMode: "list",
      });
      onPeer({ deviceId: device.deviceId, name: device.name || BLE_NAME_PREFIX });
      return;
    }
    await central.requestLEScan(
      {
        services: [LIVE_SERVICE_UUID],
        // Keep listening. The first packet often has no name, and iOS will not
        // deliver another if duplicates are suppressed.
        allowDuplicates: true,
      },
      (result) => {
        const name = boardName(result);
        if (!isMeshPeer(result)) return;
        onPeer({ deviceId: result.device.deviceId, name });
      },
    );
  }

  async stopScan(): Promise<void> {
    await this.central?.stopLEScan?.().catch(() => undefined);
  }

  async connect(remembered = false, peer?: BlePeer): Promise<void> {
    this.wantLink = true;
    const central = this.injected ?? (await loadCapacitorBle());
    this.central = central;
    try {
      await prepareCentral(central);
      await central.setDisplayStrings?.(DISPLAY);
      await this.stopScan();
      const device = peer
        ? { deviceId: peer.deviceId, name: peer.name }
        : remembered
          ? await this.savedDevice(central)
          : await this.pickDevice(central);
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
    if (command.type !== CmdType.CHECK_IN) return;
    const central = this.central;
    const deviceId = this.deviceId;
    if (!central || !deviceId || !this.writeTarget) {
      throw new Error("The beacon is not ready for commands yet.");
    }
    if (!this.link) throw new Error("The beacon is not ready for commands yet.");
    const targets =
      command.targetId === BROADCAST_ID ? this.link.knownNodes() : [command.targetId];
    if (targets.length === 0) throw new Error("The leader has not heard any other board yet.");
    for (const target of targets) await this.link.sendCheckIn(target);
  }

  private async pickDevice(central: NativeCentral): Promise<NativeDevice> {
    // The iOS device list added a row for every unnamed peripheral and labeled
    // it Leader_Device_LoRa. Taps never landed because the list kept reloading.
    // Scan quietly and connect the board that actually advertises this name.
    if (central.requestLEScan && central.stopLEScan) {
      return this.scanForLeader(central);
    }
    return central.requestDevice({
      services: [LIVE_SERVICE_UUID],
      namePrefix: BLE_NAME_PREFIX,
      displayMode: "list",
    });
  }

  private scanForLeader(central: NativeCentral): Promise<NativeDevice> {
    const scan = central.requestLEScan?.bind(central);
    const stop = central.stopLEScan?.bind(central);
    if (!scan || !stop) {
      return Promise.reject(new Error(`No ${BLE_NAME_PREFIX} in range. Is the ESP32 advertising?`));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (device?: NativeDevice, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void stop().catch(() => undefined);
        if (device) resolve(device);
        else reject(error ?? new Error(`No ${BLE_NAME_PREFIX} in range. Is the ESP32 advertising?`));
      };
      const timer = setTimeout(() => {
        finish(undefined, new Error(`No ${BLE_NAME_PREFIX} in range. Is the ESP32 advertising?`));
      }, 12000);
      void scan(
        {
          services: [LIVE_SERVICE_UUID],
          allowDuplicates: true,
        },
        (result) => {
          const name = boardName(result);
          if (!isMeshPeer(result)) return;
          finish({ deviceId: result.device.deviceId, name });
        },
      ).catch((error: unknown) => finish(undefined, explainBleError(error)));
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
      const fromNum = service.characteristics.find((item) => sameUuid(item.uuid, LIVE_TX_UUID));
      if (!fromNum) {
        throw new Error(`${BLE_NAME_PREFIX} is missing the FromNum characteristic ${LIVE_TX_UUID}.`);
      }
      const toRadio = service.characteristics.find((item) => sameUuid(item.uuid, LIVE_RX_UUID));
      if (!toRadio) {
        throw new Error(`${BLE_NAME_PREFIX} is missing the ToRadio characteristic ${LIVE_RX_UUID}.`);
      }
      const fromRadio = service.characteristics.find((item) => sameUuid(item.uuid, FROM_RADIO_UUID));
      if (!fromRadio) {
        throw new Error(`${BLE_NAME_PREFIX} is missing the FromRadio characteristic ${FROM_RADIO_UUID}.`);
      }
      this.writeTarget = { uuid: LIVE_RX_UUID, withoutResponse: false };
      this.link = new MeshLink(
        (bytes) => this.writeMesh(central, device.deviceId, bytes),
        (event) => this.emit(event),
      );

      await this.subscribeChar(central, device.deviceId, LIVE_TX_UUID);
      writeStorage(DEVICE_ID_KEY, device.deviceId);
      writeStorage(DEVICE_NAME_KEY, this.deviceName);
      this.reconnectsLeft = RECONNECT_ATTEMPTS;
      this.emit({ type: "connected", deviceName: this.deviceName });
      await this.link.configure();
      await this.drain(central, device.deviceId);
    } finally {
      this.opening = false;
    }
  }

  private async subscribeChar(
    central: NativeCentral,
    deviceId: string,
    characteristic: string,
  ): Promise<void> {
    await central.startNotifications(deviceId, LIVE_SERVICE_UUID, characteristic, () => {
      const current = this.central;
      const id = this.deviceId;
      if (!current || !id) return;
      void this.drain(current, id);
    });
  }

  private async writeMesh(central: NativeCentral, deviceId: string, bytes: Uint8Array): Promise<void> {
    const copy = new Uint8Array(bytes);
    await central.write(deviceId, LIVE_SERVICE_UUID, LIVE_RX_UUID, new DataView(copy.buffer));
  }

  /** FromNum only says the queue moved. Each read is one FromRadio protobuf. */
  private async drain(central: NativeCentral, deviceId: string): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        for (let n = 0; n < 40; n++) {
          let bytes: Uint8Array;
          try {
            bytes = viewToBytes(await central.read(deviceId, LIVE_SERVICE_UUID, FROM_RADIO_UUID));
          } catch {
            break;
          }
          if (bytes.length === 0) break;
          this.link?.push(bytes);
        }
      } while (this.drainAgain && this.wantLink);
    } finally {
      this.draining = false;
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

async function prepareCentral(central: NativeCentral): Promise<void> {
  if (!preparedCentrals.has(central)) {
    await central.initialize({ androidNeverForLocation: true });
    preparedCentrals.add(central);
  }
  if (!(await central.isEnabled())) {
    throw new Error("Bluetooth is off. Turn it on, then look again.");
  }
}

function boardName(result: NativeScanResult): string {
  return result.localName || result.device.name || BLE_NAME_PREFIX;
}

function isMeshPeer(result: NativeScanResult): boolean {
  const name = `${result.localName ?? ""} ${result.device.name ?? ""}`.toLowerCase();
  if (name.includes(BLE_NAME_PREFIX.toLowerCase())) return true;
  return (result.uuids ?? []).some((uuid) => sameUuid(uuid, LIVE_SERVICE_UUID));
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
