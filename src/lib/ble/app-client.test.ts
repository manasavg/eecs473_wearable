import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExcursionAppClient } from "./app-client.ts";
import type { BleEvent, BleTransport } from "./transport.ts";
import { BROADCAST_ID } from "./constants.ts";
import { CmdType, Status, type AppCommand, type FollowerInfo } from "./types.ts";

class ScriptedTransport implements BleTransport {
  readonly commands: AppCommand[] = [];
  private listener: ((event: BleEvent) => void) | null = null;

  async connect(): Promise<void> {
    this.listener?.({ type: "connected", deviceName: "Test beacon" });
  }

  async disconnect(): Promise<void> {
    this.listener?.({ type: "disconnected", unexpected: false });
  }

  failWrite = false;

  async writeCommand(command: AppCommand): Promise<void> {
    if (this.failWrite) throw new Error("Check-in did not reach the beacon.");
    this.commands.push(command);
  }

  subscribe(listener: (event: BleEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(event: BleEvent): void {
    this.listener?.(event);
  }
}

function follower(overrides: Partial<FollowerInfo> = {}): FollowerInfo {
  return {
    deviceId: 1,
    status: Status.OK,
    batteryPercent: 90,
    distanceM: 14,
    angleDeg: -20,
    uwbOutOfRange: false,
    ...overrides,
  };
}

describe("ExcursionAppClient", () => {
  it("connects without writing, so the LoRa board does not send CHECK IN", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ thresholdMeters: 25 });
    await client.connectDevice("beacon", transport);
    assert.equal(client.getState().connection, "connected");
    assert.equal(client.getState().deviceName, "Test beacon");
    assert.equal(transport.commands.length, 0);
    await client.disconnect();
  });

  it("check-in writes CHECK_IN and stamps every wristband for the group", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    transport.emit({ type: "follower", info: follower({ deviceId: 1 }) });
    transport.emit({ type: "follower", info: follower({ deviceId: 2, angleDeg: 15 }) });
    await client.sendCheckIn(BROADCAST_ID);
    const command = transport.commands.at(-1);
    assert.equal(command?.type, CmdType.CHECK_IN);
    assert.equal(command?.targetId, BROADCAST_ID);
    assert.ok(client.getState().groupCheckInAt);
    assert.equal(client.getState().groupOkAt, null);
    assert.ok(client.getState().members.every((member) => member.status === Status.OK));
    await client.disconnect();
  });

  it("shows the group OK only after the leader notifies OK", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    await client.sendCheckIn(BROADCAST_ID);
    assert.equal(client.getState().members.length, 0);
    assert.equal(client.getState().groupOkAt, null);
    assert.equal(client.getState().activity[0]?.kind, "checkin");
    transport.emit({ type: "live", counter: 4, text: null, hex: "04" });
    assert.equal(client.getState().groupOkAt, null);
    transport.emit({ type: "live", counter: null, text: "OK", hex: "4f 4b" });
    assert.ok(client.getState().groupOkAt);
    assert.equal(client.getState().activity[0]?.kind, "answered");
    await client.disconnect();
  });

  it("does not mark the group OK when the write fails", async () => {
    const transport = new ScriptedTransport();
    transport.failWrite = true;
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    await assert.rejects(() => client.sendCheckIn(BROADCAST_ID), /did not reach/);
    assert.equal(client.getState().groupOkAt, null);
    await client.disconnect();
  });

  it("shows the UWB distance and keeps it when the counter ticks", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    assert.equal(client.getState().uwbDistanceM, null);
    transport.emit({ type: "live", counter: null, text: null, hex: "44 d2 04", distanceM: 12.34 });
    assert.equal(client.getState().uwbDistanceM, 12.34);
    transport.emit({ type: "live", counter: 3, text: null, hex: "03" });
    assert.equal(client.getState().uwbDistanceM, 12.34);
    transport.emit({ type: "live", counter: null, text: "OK", hex: "4f 4b" });
    assert.equal(client.getState().uwbDistanceM, 12.34);
    assert.ok(client.getState().groupOkAt);
    await client.disconnect();
  });

  it("shows the ESP32 counter without inventing a wristband", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    transport.emit({
      type: "live",
      counter: null,
      text: "Data successfully transmitted",
      hex: "44 61 74 61",
    });
    transport.emit({ type: "live", counter: 7, text: null, hex: "07 00 00 00" });
    const link = client.getState().liveLink;
    assert.equal(link?.counter, 7);
    assert.equal(link?.text, "Data successfully transmitted");
    assert.equal(link?.packetCount, 2);
    assert.equal(client.getState().members.length, 0);
    transport.emit({ type: "live", counter: 8, text: null, hex: "08 00 00 00" });
    assert.equal(client.getState().liveLink?.counter, 8);
    assert.equal(client.getState().liveLink?.text, "Data successfully transmitted");
    await client.disconnect();
  });

  it("pages once when status and the alert characteristic both say Need Help", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    transport.emit({ type: "follower", info: follower() });
    const help = follower({ status: Status.NEED_HELP });
    transport.emit({ type: "follower", info: help });
    transport.emit({
      type: "alert",
      deviceId: 1,
      status: Status.NEED_HELP,
      uwbOutOfRange: false,
    });
    const state = client.getState();
    assert.equal(state.alerts.length, 1);
    assert.equal(state.alerts[0].status, Status.NEED_HELP);
    assert.equal(state.activity.filter((entry) => entry.kind === "help").length, 1);
    await client.disconnect();
  });

  it("keeps the last fix when UWB drops", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    transport.emit({ type: "follower", info: follower({ distanceM: 22.5, angleDeg: 40 }) });
    transport.emit({
      type: "follower",
      info: follower({
        status: Status.OUT_OF_RANGE,
        distanceM: null,
        angleDeg: null,
        uwbOutOfRange: true,
      }),
    });
    const member = client.getState().members[0];
    assert.equal(member.distanceM, null);
    assert.equal(member.lastDistanceM, 22.5);
    assert.equal(member.lastAngleDeg, 40);
    await client.disconnect();
  });

  it("refuses a check-in before connect", async () => {
    const client = new ExcursionAppClient();
    await assert.rejects(() => client.sendCheckIn(1), /Connect the beacon/);
  });
});
