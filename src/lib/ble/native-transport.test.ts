import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTransport } from "./create-transport.ts";
import { fromBinary } from "@bufbuild/protobuf";
import { Mesh } from "@meshtastic/protobufs";
import { NativeBleTransport, rememberedNativeBeaconName, type NativeCentral } from "./native-transport.ts";
import { CmdType } from "./types.ts";
import { BLE_NAME_PREFIX, FROM_RADIO_UUID, LIVE_RX_UUID, LIVE_SERVICE_UUID, LIVE_TX_UUID } from "./uuids.ts";
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

  initCount = 0;

  async initialize(): Promise<void> {
    this.initCount += 1;
  }
  async isEnabled(): Promise<boolean> {
    return true;
  }
  async requestDevice(options?: { services?: string[]; namePrefix?: string }): Promise<{ deviceId: string; name?: string }> {
    this.requestCount += 1;
    this.requestOptions = options;
    return { deviceId: "iphone-beacon", name: BLE_NAME_PREFIX };
  }
  requestLEScan?: NativeCentral["requestLEScan"];
  stopLEScan?: NativeCentral["stopLEScan"];
  async getDevices(deviceIds: string[]): Promise<{ deviceId: string; name?: string }[]> {
    return this.known.filter((device) => deviceIds.includes(device.deviceId));
  }
  connectedId: string | null = null;

  async connect(
    deviceId: string,
    _onDisconnect?: (deviceId: string) => void,
    options?: { timeout?: number; skipDescriptorDiscovery?: boolean },
  ): Promise<void> {
    this.connectedId = deviceId;
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
              read: true,
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
          {
            uuid: FROM_RADIO_UUID.toUpperCase(),
            properties: {
              read: true,
              write: false,
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
    return new DataView(new ArrayBuffer(0));
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

  it("subscribes to FromNum and asks the node for its database", async () => {
    const central = new FakeCentral();
    const link = new NativeBleTransport(central);
    const events = eventsOf(link);
    await link.connect();
    assert.equal(central.requestCount, 1);
    assert.deepEqual(central.requestOptions?.services, [LIVE_SERVICE_UUID]);
    assert.equal(central.requestOptions?.namePrefix, BLE_NAME_PREFIX);
    assert.deepEqual(central.subscribed, [LIVE_TX_UUID]);
    assert.equal(central.connectOptions?.skipDescriptorDiscovery, true);
    assert.equal(central.connectOptions?.timeout, 20000);
    assert.equal(events.some((event) => event.type === "connected" && event.deviceName === BLE_NAME_PREFIX), true);
    assert.equal(central.writtenTo[0], LIVE_RX_UUID);
    const hello = fromBinary(Mesh.ToRadioSchema, central.writes[0]);
    assert.equal(hello.payloadVariant.case, "wantConfigId");
    assert.equal(rememberedNativeBeaconName(), BLE_NAME_PREFIX);

    await link.writeCommand({ type: CmdType.CHECK_IN, targetId: 2, thresholdMeters: 0 });
    const sent = fromBinary(Mesh.ToRadioSchema, central.writes[1]);
    assert.equal(sent.payloadVariant.case, "packet");
    if (sent.payloadVariant.case !== "packet") return;
    assert.equal(sent.payloadVariant.value.payloadVariant.case, "decoded");
    if (sent.payloadVariant.value.payloadVariant.case !== "decoded") return;
    const text = new TextDecoder().decode(sent.payloadVariant.value.payloadVariant.value.payload);
    assert.equal(text, "CHECK IN");
    await link.disconnect();
  });

  it("connects the named leader and skips unnamed scan results", async () => {
    const central = new FakeCentral();
    let stopped = false;
    central.requestLEScan = async (_options, callback) => {
      callback({ device: { deviceId: "headphones" } });
      callback({ device: { deviceId: "other", name: "Something Else" }, localName: "Something Else" });
      callback({ device: { deviceId: "leader" }, localName: BLE_NAME_PREFIX });
    };
    central.stopLEScan = async () => {
      stopped = true;
    };
    const link = new NativeBleTransport(central);
    await link.connect();
    assert.equal(central.requestCount, 0);
    assert.equal(stopped, true);
    assert.equal(rememberedNativeBeaconName(), BLE_NAME_PREFIX);
    await link.disconnect();
  });

  it("lists the named boards and connects the one you pick", async () => {
    const central = new FakeCentral();
    let stopped = false;
    central.requestLEScan = async (_options, callback) => {
      callback({ device: { deviceId: "board-a" }, localName: `${BLE_NAME_PREFIX}A3` });
      callback({ device: { deviceId: "board-a" }, localName: `${BLE_NAME_PREFIX}A3` });
      callback({ device: { deviceId: "unnamed" } });
      callback({ device: { deviceId: "board-b", name: "Other" }, localName: `${BLE_NAME_PREFIX}_1F` });
      callback({
        device: { deviceId: "board-f1", name: "Hiker" },
        uuids: [LIVE_SERVICE_UUID],
      });
    };
    central.stopLEScan = async () => {
      stopped = true;
    };
    const link = new NativeBleTransport(central);
    const names: string[] = [];
    await link.scan((peer) => names.push(peer.name));
    assert.deepEqual(names, [
      `${BLE_NAME_PREFIX}A3`,
      `${BLE_NAME_PREFIX}A3`,
      `${BLE_NAME_PREFIX}_1F`,
      "Hiker",
    ]);
    await link.connect(false, { deviceId: "board-b", name: `${BLE_NAME_PREFIX}_1F` });
    assert.equal(central.requestCount, 0);
    assert.equal(central.connectedId, "board-b");
    assert.equal(stopped, true);
    assert.equal(rememberedNativeBeaconName(), `${BLE_NAME_PREFIX}_1F`);
    await link.disconnect();
  });

  it("also lists a board this phone is already connected to, which stops advertising", async () => {
    const central = new FakeCentral() as FakeCentral & {
      getConnectedDevices?: (services: string[]) => Promise<{ deviceId: string; name?: string }[]>;
    };
    central.requestLEScan = async (_options, callback) => {
      callback({ device: { deviceId: "board-19e8" }, localName: "Meshtastic_19e8" });
    };
    central.stopLEScan = async () => undefined;
    let asked: string[] = [];
    central.getConnectedDevices = async (services) => {
      asked = services;
      return [{ deviceId: "board-a688", name: "Meshtastic_a688" }];
    };
    const link = new NativeBleTransport(central);
    const names: string[] = [];
    await link.scan((peer) => names.push(peer.name));
    assert.deepEqual(names, ["Meshtastic_19e8", "Meshtastic_a688"]);
    assert.deepEqual(asked, [LIVE_SERVICE_UUID]);
  });

  it("connects a scanned board without starting Bluetooth over again", async () => {
    const central = new FakeCentral();
    central.requestLEScan = async (_options, callback) => {
      callback({
        device: { deviceId: "board-89", name: "Leader_Device_LoRa" },
        localName: `${BLE_NAME_PREFIX}89`,
      });
    };
    central.stopLEScan = async () => {};
    const scanner = new NativeBleTransport(central);
    const names: string[] = [];
    await scanner.scan((peer) => names.push(peer.name));
    const link = new NativeBleTransport(central);
    await link.connect(false, { deviceId: "board-89", name: names[0] });
    assert.deepEqual(names, [`${BLE_NAME_PREFIX}89`]);
    assert.equal(central.initCount, 1);
    assert.equal(central.connectedId, "board-89");
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
