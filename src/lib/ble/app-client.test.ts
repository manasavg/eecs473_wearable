import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExcursionAppClient, isInGroup } from "./app-client.ts";
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
  it("sends the range on connect and does not send CHECK IN", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ thresholdMeters: 25 });
    await client.connectDevice("beacon", transport);
    assert.equal(client.getState().connection, "connected");
    assert.equal(client.getState().deviceName, "Test beacon");
    assert.equal(transport.commands.length, 1);
    assert.equal(transport.commands[0]?.type, CmdType.SET_THRESHOLD);
    assert.equal(transport.commands[0]?.thresholdMeters, 25);
    assert.ok(transport.commands.every((command) => command.type !== CmdType.CHECK_IN));
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

  it("shows the GPS fix and keeps it when the counter ticks", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    assert.equal(client.getState().gpsFix, null);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "47 01",
      gps: { fix: true, lat: 42.5, lon: -83.25 },
    });
    assert.equal(client.getState().gpsFix, true);
    assert.equal(client.getState().gpsLat, 42.5);
    assert.equal(client.getState().gpsLon, -83.25);
    transport.emit({ type: "live", counter: 3, text: null, hex: "03" });
    assert.equal(client.getState().gpsLat, 42.5);
    transport.emit({ type: "live", counter: null, text: "OK", hex: "4f 4b" });
    assert.equal(client.getState().gpsLon, -83.25);
    assert.ok(client.getState().groupOkAt);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "47 00",
      gps: { fix: false, lat: null, lon: null },
    });
    assert.equal(client.getState().gpsFix, false);
    assert.equal(client.getState().gpsLat, null);
    assert.equal(client.getState().gpsLon, null);
    await client.disconnect();
  });

  it("shows the GPS distance and clears it when either fix drops", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    assert.equal(client.getState().separationKnown, null);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "4d",
      separation: { known: true, meters: 12.3 },
    });
    assert.equal(client.getState().separationKnown, true);
    assert.equal(client.getState().separationM, 12.3);
    transport.emit({ type: "live", counter: 3, text: null, hex: "03" });
    assert.equal(client.getState().separationM, 12.3);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "4d ff ff ff ff",
      separation: { known: false, meters: null },
    });
    assert.equal(client.getState().separationKnown, false);
    assert.equal(client.getState().separationM, null);
    assert.equal(client.getState().outOfRange, false);
    await client.disconnect();
  });

  it("keeps the follower fix and marks out of range past the limit", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ thresholdMeters: 40 });
    await client.connectDevice("beacon", transport);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "46",
      followerGps: { fix: true, lat: 42.4, lon: -83.2 },
    });
    assert.equal(client.getState().followerFix, true);
    assert.equal(client.getState().followerLat, 42.4);
    transport.emit({ type: "live", counter: 3, text: null, hex: "03" });
    assert.equal(client.getState().followerLon, -83.2);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "4d",
      separation: { known: true, meters: 55 },
    });
    assert.equal(client.getState().outOfRange, true);
    client.setThreshold(80);
    assert.equal(client.getState().outOfRange, false);
    assert.equal(client.getState().thresholdMeters, 80);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "46 00",
      followerGps: { fix: false, lat: null, lon: null },
    });
    assert.equal(client.getState().followerFix, false);
    assert.equal(client.getState().followerLat, null);
    await client.disconnect();
  });

  it("tracks two followers and clears the one that stops answering", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ thresholdMeters: 40 });
    await client.connectDevice("beacon", transport);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "46",
      followerGps: { id: 0xa3, fix: true, lat: 42.2, lon: -83.1 },
    });
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "4d",
      separation: { id: 0xa3, known: true, meters: 10 },
    });
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "46",
      followerGps: { id: 0x1f, fix: true, lat: 42.9, lon: -83.8 },
    });
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "4d",
      separation: { id: 0x1f, known: true, meters: 55 },
    });
    const followers = client.getState().followers;
    assert.equal(followers.length, 2);
    assert.equal(followers.find((item) => item.id === 0xa3)?.outOfRange, false);
    assert.equal(followers.find((item) => item.id === 0x1f)?.outOfRange, true);
    assert.equal(client.getState().outOfRange, true);
    assert.equal(followers.find((item) => item.id === 0xa3)?.separationM, 10);
    transport.emit({ type: "live", counter: null, text: null, hex: "58 1f", followerGoneId: 0x1f });
    assert.equal(client.getState().followers.length, 1);
    assert.equal(client.getState().followers[0]?.id, 0xa3);
    assert.equal(client.getState().outOfRange, false);
    transport.emit({ type: "live", counter: null, text: "OK", hex: "4f 4b a3", okId: 0xa3 });
    assert.equal(client.getState().groupOkId, 0xa3);
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

  function clock(start = 1_700_000_000_000) {
    let now = start;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  function followerAt(transport: ScriptedTransport, id: number, lat: number, heardAt?: number) {
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "",
      followerGps: { id, fix: true, lat, lon: -83.74, name: `Board ${id}`, heardAt },
    });
  }

  it("checks in one board and marks only that board OK on its acknowledgement", async () => {
    const time = clock();
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ now: time.now });
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0xa3, 42.28, time.now());
    followerAt(transport, 0x1f, 42.28, time.now());
    await client.sendCheckIn(0xa3);
    const checkIns = transport.commands.filter((command) => command.type === CmdType.CHECK_IN);
    assert.deepEqual(checkIns.map((command) => command.targetId), [0xa3]);
    const card = () => client.getState().followers.find((item) => item.id === 0xa3);
    assert.equal(card()?.checkIn?.status, "sending");
    assert.equal(client.getState().followers.find((item) => item.id === 0x1f)?.checkIn, null);
    transport.emit({ type: "checkin-sent", id: 0xa3, packetId: 77 });
    assert.equal(card()?.checkIn?.status, "waiting");
    transport.emit({ type: "checkin-ack", id: 0xa3, packetId: 76 });
    assert.equal(card()?.checkIn?.status, "waiting");
    transport.emit({ type: "checkin-ack", id: 0xa3, packetId: 77 });
    assert.equal(card()?.checkIn?.status, "received");
    transport.emit({ type: "live", counter: null, text: "OK detected", hex: "", okId: 0xa3 });
    assert.equal(card()?.checkIn?.status, "ok");
    assert.equal(card()?.checkIn?.confirmedBy, "person");
    await client.disconnect();
  });

  it("checks in every tracked board for the group button", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    for (const id of [0x10, 0x20, 0x30, 0x40]) followerAt(transport, id, 42.28, Date.now());
    await client.sendCheckIn(BROADCAST_ID);
    const checkIns = transport.commands.filter((command) => command.type === CmdType.CHECK_IN);
    assert.deepEqual(checkIns.map((command) => command.targetId), [0x10, 0x20, 0x30, 0x40]);
    assert.ok(client.getState().followers.every((item) => item.checkIn?.status === "sending"));
    await client.disconnect();
  });

  it("shows No answer after the timeout and still accepts a late OK reply", async () => {
    const time = clock();
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ now: time.now });
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0xa3, 42.28, time.now());
    await client.sendCheckIn(0xa3);
    time.advance(121_000);
    client.tick();
    assert.equal(client.getState().followers[0]?.checkIn?.status, "noAnswer");
    transport.emit({ type: "live", counter: null, text: "OK", hex: "", okId: 0xa3 });
    assert.equal(client.getState().followers[0]?.checkIn?.status, "ok");
    await client.disconnect();
  });

  it("does not mark a board OK for an OK text when no check-in is open", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0xa3, 42.28, Date.now());
    transport.emit({ type: "live", counter: null, text: "OK", hex: "", okId: 0xa3 });
    assert.equal(client.getState().followers[0]?.checkIn, null);
    await client.disconnect();
  });

  it("flags a board that goes silent and clears it when heard again", async () => {
    const time = clock();
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ now: time.now, silenceSeconds: 60 });
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0xa3, 42.28, time.now());
    assert.equal(client.getState().followers[0]?.silent, false);
    time.advance(59_000);
    client.tick();
    assert.equal(client.getState().followers[0]?.silent, false);
    time.advance(2_000);
    client.tick();
    assert.equal(client.getState().followers[0]?.silent, true);
    transport.emit({ type: "heard", id: 0xa3, at: time.now() });
    assert.equal(client.getState().followers[0]?.silent, false);
    await client.disconnect();
  });

  it("counts silence from connect for a board the radio never timed", async () => {
    const time = clock();
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ now: time.now, silenceSeconds: 60 });
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0xa3, 42.28);
    time.advance(61_000);
    client.tick();
    assert.equal(client.getState().followers[0]?.silent, true);
    await client.disconnect();
  });

  it("drops the distance when either GPS fix is lost", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ thresholdMeters: 40 });
    await client.connectDevice("beacon", transport);
    transport.emit({ type: "live", counter: null, text: null, hex: "", gps: { fix: true, lat: 42.28, lon: -83.74 } });
    followerAt(transport, 0xa3, 42.281, Date.now());
    const first = client.getState().followers[0];
    assert.equal(first?.separationKnown, true);
    assert.equal(first?.outOfRange, true);
    transport.emit({ type: "live", counter: null, text: null, hex: "", gps: { fix: false, lat: null, lon: null } });
    const after = client.getState().followers[0];
    assert.equal(after?.separationKnown, false);
    assert.equal(after?.separationM, null);
    assert.equal(after?.outOfRange, false);
    transport.emit({ type: "live", counter: null, text: null, hex: "", gps: { fix: true, lat: 42.28, lon: -83.74 } });
    assert.equal(client.getState().followers[0]?.separationKnown, true);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "",
      followerGps: { id: 0xa3, fix: false, lat: null, lon: null },
    });
    assert.equal(client.getState().followers[0]?.separationKnown, false);
    await client.disconnect();
  });

  it("keeps the last known fix and its time when the fix drops", async () => {
    const time = clock();
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ now: time.now });
    await client.connectDevice("beacon", transport);
    const takenAt = time.now();
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "",
      followerGps: { id: 0xa3, fix: true, lat: 42.281, lon: -83.74, heardAt: takenAt, positionAt: takenAt },
    });
    time.advance(30_000);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "",
      followerGps: { id: 0xa3, fix: false, lat: null, lon: null, heardAt: time.now(), positionAt: time.now() },
    });
    const card = client.getState().followers[0];
    assert.equal(card?.fix, false);
    assert.equal(card?.lat, null);
    assert.deepEqual(card?.lastKnown, { lat: 42.281, lon: -83.74, at: takenAt });
    await client.disconnect();
  });

  it("does not replace a last known fix with an older one", async () => {
    const time = clock();
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ now: time.now });
    client.rememberLastKnown({ 0xa3: { lat: 42.29, lon: -83.75, at: time.now() } });
    await client.connectDevice("beacon", transport);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "",
      followerGps: { id: 0xa3, fix: true, lat: 42.2, lon: -83.7, positionAt: time.now() - 3_600_000 },
    });
    assert.deepEqual(client.getState().followers[0]?.lastKnown, { lat: 42.29, lon: -83.75, at: time.now() });
    time.advance(5_000);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "",
      followerGps: { id: 0xa3, fix: true, lat: 42.3, lon: -83.76, positionAt: time.now() },
    });
    assert.deepEqual(client.getState().followers[0]?.lastKnown, { lat: 42.3, lon: -83.76, at: time.now() });
    await client.disconnect();
  });

  it("keeps last known fixes across a reconnect", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0xa3, 42.281, Date.now());
    await client.disconnect();
    assert.equal(client.getState().followers.length, 0);
    await client.connectDevice("beacon", transport);
    transport.emit({
      type: "live",
      counter: null,
      text: null,
      hex: "",
      followerGps: { id: 0xa3, fix: false, lat: null, lon: null },
    });
    assert.equal(client.getState().followers[0]?.lastKnown?.lat, 42.281);
    assert.equal(client.getLastKnown()[0xa3]?.lat, 42.281);
    await client.disconnect();
  });

  it("shows No OK pressed when the board got it but nobody pressed OK", async () => {
    const time = clock();
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ now: time.now });
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0xa3, 42.28, time.now());
    await client.sendCheckIn(0xa3);
    transport.emit({ type: "checkin-sent", id: 0xa3, packetId: 5 });
    transport.emit({ type: "checkin-ack", id: 0xa3, packetId: 5 });
    time.advance(121_000);
    client.tick();
    const checkIn = () => client.getState().followers[0]?.checkIn;
    assert.equal(checkIn()?.status, "unconfirmed");
    // A press that comes late still counts.
    transport.emit({ type: "live", counter: null, text: "OK", hex: "", okId: 0xa3 });
    assert.equal(checkIn()?.status, "ok");
    assert.equal(checkIn()?.confirmedBy, "person");
    await client.disconnect();
  });

  it("counts the radio acknowledgement as OK when no press is required", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ requireConfirm: false });
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0xa3, 42.28, Date.now());
    await client.sendCheckIn(0xa3);
    transport.emit({ type: "checkin-sent", id: 0xa3, packetId: 9 });
    transport.emit({ type: "checkin-ack", id: 0xa3, packetId: 9 });
    const checkIn = client.getState().followers[0]?.checkIn;
    assert.equal(checkIn?.status, "ok");
    assert.equal(checkIn?.confirmedBy, "radio");
    await client.disconnect();
  });

  it("ignores a radio failure that arrives after the board received it", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0xa3, 42.28, Date.now());
    await client.sendCheckIn(0xa3);
    transport.emit({ type: "checkin-sent", id: 0xa3, packetId: 3 });
    transport.emit({ type: "checkin-ack", id: 0xa3, packetId: 3 });
    transport.emit({ type: "checkin-failed", id: 0xa3, packetId: 3, noAnswer: true, reason: "No answer" });
    assert.equal(client.getState().followers[0]?.checkIn?.status, "received");
    await client.disconnect();
  });

  it("lists a board heard before it has a position or a name", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    transport.emit({ type: "node-seen", id: 0xa3, name: "Meshtastic 00A3", at: Date.now() });
    const card = client.getState().followers[0];
    assert.equal(card?.id, 0xa3);
    assert.equal(card?.name, "Meshtastic 00A3");
    assert.equal(card?.fix, null);
    await client.disconnect();
  });

  it("never lists the connected board as a follower", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    client.setGroup([
      { suffix: "0011", name: "Leader" },
      { suffix: "a688", name: "Meshtastic_a688" },
    ]);
    transport.emit({ type: "my-node", id: 0x11 });
    followerAt(transport, 0x9e2ca688, 42.28, Date.now());
    assert.deepEqual(client.getState().followers.map((item) => item.id), [0x9e2ca688]);
    await client.disconnect();
  });

  it("shows a group member not heard yet and flags it after the silence limit", async () => {
    const time = clock();
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ now: time.now, silenceSeconds: 60 });
    client.setGroup([{ suffix: "19e8", name: "Meshtastic_19e8" }]);
    await client.connectDevice("beacon", transport);
    const card = () => client.getState().followers.find((item) => item.name === "Meshtastic_19e8");
    assert.equal(card()?.placeholder, true);
    assert.equal(card()?.lastHeardAt, null);
    await assert.rejects(() => client.sendCheckIn(card()!.id), /not been heard/);
    time.advance(61_000);
    client.tick();
    assert.equal(card()?.silent, true);
    // Once the radio hears it, the real board replaces the stand-in.
    followerAt(transport, 0x7a1219e8, 42.28, time.now());
    const ids = client.getState().followers.map((item) => item.id);
    assert.deepEqual(ids, [0x7a1219e8]);
    assert.equal(client.getState().followers[0]?.placeholder, false);
    await client.disconnect();
  });

  it("checks in and alerts only for group members", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ thresholdMeters: 40 });
    await client.connectDevice("beacon", transport);
    client.setGroup([{ suffix: "00a3", name: "A3" }]);
    transport.emit({ type: "live", counter: null, text: null, hex: "", gps: { fix: true, lat: 42.28, lon: -83.74 } });
    followerAt(transport, 0xa3, 42.2801, Date.now());
    followerAt(transport, 0x77, 42.29, Date.now());
    assert.equal(client.getState().followers.find((item) => item.id === 0x77)?.outOfRange, true);
    assert.equal(client.getState().outOfRange, false);
    await client.sendCheckIn(BROADCAST_ID);
    const checkIns = transport.commands.filter((command) => command.type === CmdType.CHECK_IN);
    assert.deepEqual(checkIns.map((command) => command.targetId), [0xa3]);
    await client.disconnect();
  });

  it("reads the 4 hex digits from a Meshtastic Bluetooth name", async () => {
    const { peerSuffix, nodeSuffix } = await import("./app-client.ts");
    assert.equal(peerSuffix("Meshtastic_a688"), "a688");
    assert.equal(peerSuffix("Meshtastic_19E8"), "19e8");
    assert.equal(peerSuffix("Trail lead_0c3f"), "0c3f");
    assert.equal(peerSuffix("Meshtastic"), null);
    assert.equal(nodeSuffix(0x9e2ca688), "a688");
    assert.equal(nodeSuffix(0x000019e8), "19e8");
  });

  it("shows each board's last message and counts a reply starting with OK", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0xa3, 42.28, Date.now());
    transport.emit({ type: "live", counter: null, text: "hello", hex: "", fromId: 0xa3, okId: null });
    assert.equal(client.getState().followers[0]?.lastText?.text, "hello");
    await client.sendCheckIn(0xa3);
    transport.emit({ type: "live", counter: null, text: "not ok", hex: "", fromId: 0xa3, okId: null });
    assert.equal(client.getState().followers[0]?.lastText?.text, "not ok");
    assert.equal(client.getState().followers[0]?.checkIn?.status, "sending");
    transport.emit({ type: "live", counter: null, text: "OK thanks", hex: "", fromId: 0xa3, okId: 0xa3 });
    assert.equal(client.getState().followers[0]?.checkIn?.status, "ok");
    await client.disconnect();
  });

  it("confirms a check-in on an OK button press whatever the button is named", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    followerAt(transport, 0x19e8, 42.28, Date.now());
    await client.sendCheckIn(0x19e8);
    transport.emit({ type: "checkin-sent", id: 0x19e8, packetId: 41 });
    transport.emit({ type: "checkin-ack", id: 0x19e8, packetId: 41 });
    assert.equal(client.getState().followers[0]?.checkIn?.status, "received");
    transport.emit({ type: "ok-press", id: 0x19e8, text: "Detected detected" });
    const card = client.getState().followers[0];
    assert.equal(card?.checkIn?.status, "ok");
    assert.equal(card?.checkIn?.confirmedBy, "person");
    assert.equal(card?.lastText?.text, "Detected detected");
    await client.disconnect();
  });

  it("shows each board's battery and counts the report as hearing it", async () => {
    const time = clock();
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient({ now: time.now, silenceSeconds: 60 });
    await client.connectDevice("beacon", transport);
    transport.emit({ type: "my-node", id: 0x11 });
    followerAt(transport, 0xa3, 42.28, time.now());
    time.advance(55_000);
    transport.emit({ type: "battery", id: 0xa3, percent: 87, voltage: 4.0 });
    time.advance(55_000);
    client.tick();
    const card = client.getState().followers[0];
    assert.equal(card?.battery?.percent, 87);
    assert.equal(card?.silent, false);
    transport.emit({ type: "battery", id: 0x11, percent: 101, voltage: 4.2 });
    assert.equal(client.getState().leaderBatteryPercent, 101);
    await client.disconnect();
  });

  describe("emergency", () => {
    async function setup() {
      const time = clock();
      const transport = new ScriptedTransport();
      const client = new ExcursionAppClient({ now: time.now });
      await client.connectDevice("beacon", transport);
      transport.emit({ type: "my-node", id: 0x11 });
      followerAt(transport, 0x19e8, 42.281, time.now());
      const press = () => transport.emit({ type: "ok-press", id: 0x19e8, text: "OK state: 1", edge: "press" });
      const release = () => transport.emit({ type: "ok-press", id: 0x19e8, text: "OK state: 0", edge: "release" });
      return { time, transport, client, press, release };
    }

    it("raises an emergency when the button is held 3 s, with the last known location", async () => {
      const { time, client, press, release } = await setup();
      press();
      time.advance(3_400);
      release();
      const [emergency] = client.getState().emergencies;
      assert.equal(emergency?.id, 0x19e8);
      assert.equal(emergency?.how, "hold");
      assert.equal(emergency?.name, "Board 6632");
      assert.equal(emergency?.lastKnown?.lat, 42.281);
      client.acknowledgeEmergency(0x19e8);
      assert.equal(client.getState().emergencies.length, 0);
      await client.disconnect();
    });

    it("treats a short press as OK, not an emergency", async () => {
      const { time, client, press, release } = await setup();
      await client.sendCheckIn(0x19e8);
      press();
      time.advance(900);
      release();
      assert.equal(client.getState().emergencies.length, 0);
      assert.equal(client.getState().followers[0]?.checkIn?.status, "ok");
      await client.disconnect();
    });

    it("goes off while the button is still held, without waiting for the release", async () => {
      const { time, client, press, release } = await setup();
      press();
      time.advance(500);
      release();
      press();
      time.advance(3_900);
      client.tick();
      assert.equal(client.getState().emergencies.length, 0);
      time.advance(200);
      client.tick();
      assert.equal(client.getState().emergencies[0]?.how, "hold");
      // Letting go afterwards does not raise a second one.
      time.advance(3_000);
      release();
      assert.equal(client.getState().emergencies.length, 1);
      await client.disconnect();
    });

    it("counts every hold length past 3 s", async () => {
      for (const holdMs of [3_200, 4_500, 6_000, 7_500]) {
        const { time, client, press, release } = await setup();
        press();
        time.advance(400);
        release();
        press();
        time.advance(holdMs);
        client.tick();
        release();
        assert.equal(client.getState().emergencies.length, 1, `hold of ${holdMs} ms`);
        await client.disconnect();
      }
    });

    it("never guesses a hold for a board that has not reported a release", async () => {
      const { time, client, press } = await setup();
      press();
      time.advance(20_000);
      client.tick();
      assert.equal(client.getState().emergencies.length, 0);
      await client.disconnect();
    });

    it("raises one for an SOS message and keeps it across a reconnect", async () => {
      const { transport, client } = await setup();
      transport.emit({ type: "emergency", id: 0x19e8, text: "SOS" });
      assert.equal(client.getState().emergencies[0]?.how, "message");
      await client.disconnect();
      assert.equal(client.getState().emergencies.length, 1);
    });

    it("ignores emergencies from boards outside the group", async () => {
      const { transport, client } = await setup();
      client.setGroup([{ suffix: "19e8", name: "Ours" }]);
      transport.emit({ type: "emergency", id: 0x7777, text: "SOS" });
      assert.equal(client.getState().emergencies.length, 0);
      await client.disconnect();
    });
  });

  describe("Bluetooth name digits that differ from the node number", () => {
    it("never shows the connected board's own card, and moves its group entry to the real digits", async () => {
      const transport = new ScriptedTransport();
      // The board advertises as Meshtastic_1a2b, but its node number ends in c3d4.
      transport.connect = async function () {
        this.emit({ type: "connected", deviceName: "Meshtastic_1a2b" });
      };
      const client = new ExcursionAppClient();
      client.setGroup([
        { suffix: "1a2b", name: "Meshtastic_1a2b" },
        { suffix: "5e6f", name: "Meshtastic_5e6f" },
      ]);
      await client.connectDevice("beacon", transport);
      assert.deepEqual(
        client.getState().followers.map((item) => item.name),
        ["Meshtastic_5e6f"],
      );
      transport.emit({ type: "my-node", id: 0x9900c3d4 });
      assert.deepEqual(
        client.getState().group.map((member) => member.suffix).sort(),
        ["5e6f", "c3d4"],
      );
      assert.deepEqual(
        client.getState().followers.map((item) => item.name),
        ["Meshtastic_5e6f"],
      );
      await client.disconnect();
    });

    it("learns a follower's real digits so its heard card replaces the stand-in", async () => {
      const transport = new ScriptedTransport();
      const client = new ExcursionAppClient();
      client.setGroup([{ suffix: "5e6f", name: "Follower" }]);
      await client.connectDevice("beacon", transport);
      followerAt(transport, 0x77001234, 42.28, Date.now());
      // Heard, but under different digits: still a stand-in in the group.
      assert.equal(client.getState().followers.find((item) => item.name === "Follower")?.placeholder, true);
      client.learnBoard("5e6f", 0x77001234);
      const cards = client.getState().followers.filter((item) => isInGroup(client.getState(), item.id));
      assert.deepEqual(cards.map((item) => item.id), [0x77001234]);
      assert.equal(cards[0]?.placeholder, false);
      await client.disconnect();
    });
  });
});
