import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTransport } from "./create-transport.ts";
import { encodeCommand } from "./protocol.ts";
import { NativeBleTransport, rememberedNativeBeaconName, type NativeCentral } from "./native-transport.ts";
import { CmdType } from "./types.ts";
import { BLE_NAME_PREFIX, LIVE_RX_UUID, LIVE_SERVICE_UUID, LIVE_TX_UUID } from "./uuids.ts";
import { WebBluetoothTransport } from "./web-bluetooth-transport.ts";
import type { BleEvent } from "./transport.ts";

class FakeCentral implements NativeCentral {
  requestCount = 0;
  requestOptions: { services?: string[]; namePrefix?: string } | undefined;
  subscribed: string[] = [];
  writtenTo: string[] = [];
  connectOptions: { timeout?: number; skipDescriptorDiscovery?: boolean } | undefined;
  readonly writes: Uint8Array[] = [];
  private notify: ((value: DataView) => void) | null = null;
  known: { deviceId: string; name?: string }[] = [];

  async initialize(): Promise<void> {}
  async isEnabled(): Promise<boolean> {
    return true;
  }
  async requestDevice(options?: { services?: string[]; namePrefix?: string }): Promise<{ deviceId: string; name?: string }> {
    this.requestCount += 1;
    this.requestOptions = options;
    return { deviceId: "iphone-beacon", name: BLE_NAME_PREFIX };
  }
  async getDevices(deviceIds: string[]): Promise<{ deviceId: string; name?: string }[]> {
    return this.known.filter((device) => deviceIds.includes(device.deviceId));
  }
  async connect(
    _deviceId: string,
    _onDisconnect?: (deviceId: string) => void,
    options?: { timeout?: number; skipDescriptorDiscovery?: boolean },
  ): Promise<void> {
    this.connectOptions = options;
  }
  async disconnect(): Promise<void> {}
  async getServices() {
    return [
      {
        uuid: LIVE_SERVICE_UUID.toUpperCase(),
        characteristics: [
          {
            uuid: LIVE_TX_UUID.toUpperCase(),
            properties: {
              read: false,
              write: false,
              writeWithoutResponse: false,
              notify: true,
              indicate: false,
            },
          },
          {
            uuid: LIVE_RX_UUID.toUpperCase(),
            properties: {
              read: false,
              write: true,
              writeWithoutResponse: false,
              notify: false,
              indicate: false,
            },
          },
        ],
      },
    ];
  }
  async read(): Promise<DataView> {
    return new DataView(new Uint8Array([0]).buffer);
  }
  async write(
    _deviceId: string,
    _service: string,
    characteristic: string,
    value: DataView,
  ): Promise<void> {
    this.writtenTo.push(characteristic);
    this.writes.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  async writeWithoutResponse(): Promise<void> {}
  async startNotifications(
    _deviceId: string,
    _service: string,
    characteristic: string,
    callback: (value: DataView) => void,
  ): Promise<void> {
    this.subscribed.push(characteristic);
    this.notify = callback;
  }
  async stopNotifications(): Promise<void> {}

  push(bytes: Uint8Array): void {
    this.notify?.(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
}

function eventsOf(link: NativeBleTransport): BleEvent[] {
  const events: BleEvent[] = [];
  link.subscribe((event) => events.push(event));
  return events;
}

describe("NativeBleTransport", () => {
  it("uses web bluetooth outside the iPhone shell", () => {
    assert.equal(createTransport("beacon") instanceof WebBluetoothTransport, true);
  });

  it("subscribes to Leader_Device and shows the counter", async () => {
    const central = new FakeCentral();
    const link = new NativeBleTransport(central);
    const events = eventsOf(link);
    await link.connect();
    assert.equal(central.requestCount, 1);
    assert.equal(central.requestOptions?.services, undefined);
    assert.equal(central.requestOptions?.namePrefix, BLE_NAME_PREFIX);
    assert.deepEqual(central.subscribed, [LIVE_TX_UUID]);
    assert.equal(central.connectOptions?.skipDescriptorDiscovery, true);
    assert.equal(central.connectOptions?.timeout, 20000);
    assert.equal(events.some((event) => event.type === "connected" && event.deviceName === BLE_NAME_PREFIX), true);
    central.push(new Uint8Array([5]));
    assert.equal(events.some((event) => event.type === "live" && event.counter === 5), true);
    assert.equal(rememberedNativeBeaconName(), BLE_NAME_PREFIX);

    await link.writeCommand({ type: CmdType.CHECK_IN, targetId: 2, thresholdMeters: 0 });
    assert.deepEqual(central.writtenTo, [LIVE_RX_UUID]);
    assert.deepEqual([...central.writes[0]], [...encodeCommand({ type: CmdType.CHECK_IN, targetId: 2, thresholdMeters: 0 })]);
    await link.disconnect();
  });

  it("reconnects a saved beacon without showing the list again", async () => {
    const first = new FakeCentral();
    const initial = new NativeBleTransport(first);
    await initial.connect();
    await initial.disconnect();

    const central = new FakeCentral();
    central.known = [{ deviceId: "iphone-beacon", name: BLE_NAME_PREFIX }];
    const link = new NativeBleTransport(central);
    const events = eventsOf(link);
    await link.connect(true);
    assert.equal(central.requestCount, 0);
    assert.equal(events.some((event) => event.type === "connected"), true);
    await link.disconnect();
  });
});
