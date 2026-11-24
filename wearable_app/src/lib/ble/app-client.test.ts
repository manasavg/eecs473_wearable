import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExcursionAppClient } from "./app-client.ts";
import type { BleEvent, BleTransport } from "./transport.ts";
import { MESH_BROADCAST_ID } from "./constants.ts";

class ScriptedTransport implements BleTransport {
  readonly targets: number[] = [];
  private listener: ((event: BleEvent) => void) | null = null;

  async connect(): Promise<void> {
    this.listener?.({ type: "connected", deviceName: "Test beacon" });
  }

  async disconnect(): Promise<void> {
    this.listener?.({ type: "disconnected", unexpected: false });
  }

  failWrite = false;

  async sendCheckIn(targetId: number): Promise<void> {
    if (this.failWrite) throw new Error("Check-in did not reach the beacon.");
    this.targets.push(targetId);
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

describe("ExcursionAppClient", () => {
  it("connects without sending a check-in", async () => {
    const transport = new ScriptedTransport();
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    assert.equal(client.getState().connection, "connected");
    assert.deepEqual(transport.targets, []);
    await client.disconnect();
  });

  it("marks each broadcast recipient failed when the write fails", async () => {
    const transport = new ScriptedTransport();
    transport.failWrite = true;
    const client = new ExcursionAppClient();
    await client.connectDevice("beacon", transport);
    await assert.rejects(() => client.sendCheckIn(MESH_BROADCAST_ID, [0xa3, 0xb4]), /did not reach/);
    assert.equal(client.getState().checkIns[0xa3].status, "failed");
    assert.equal(client.getState().checkIns[0xb4].status, "failed");
    await client.disconnect();
  });

  it("refuses a check-in before connecting", async () => {
    const client = new ExcursionAppClient();
    await assert.rejects(() => client.sendCheckIn(0xa3), /Connect the beacon/);
  });
});

it("keeps delivery, OK and help independent across followers", async () => {
  const client = new ExcursionAppClient();
  const transport = new ScriptedTransport();
  await client.connectDevice("beacon", transport);
  for (const id of [0xa3, 0xb4]) {
    await client.parseData({ type: "node-seen", id, name: `Wearable ${id}`, at: null });
    await client.sendCheckIn(id);
    await client.parseData({ type: "checkin-sent", id, packetId: id + 1 });
  }
  await client.parseData({ type: "checkin-ack", id: 0xa3, packetId: 0xb5 });
  assert.equal(client.getState().checkIns[0xa3].status, "waiting");
  await client.parseData({ type: "checkin-ack", id: 0xa3, packetId: 0xa4 });
  assert.equal(client.getState().checkIns[0xa3].status, "received");
  assert.equal(client.getState().checkIns[0xb4].status, "waiting");
  await client.parseData({ type: "live", text: "OK", fromId: 0xa3 });
  await client.parseData({ type: "live", text: "NEED HELP", fromId: 0xb4 });
  assert.equal(client.getState().checkIns[0xa3].status, "ok");
  assert.equal(client.getState().checkIns[0xb4].status, "help");
  await client.disconnect();
});

it("records four independent OK replies to a group broadcast even before discovery", async () => {
  const client = new ExcursionAppClient();
  const transport = new ScriptedTransport();
  await client.connectDevice("beacon", transport);
  const followers = [0xa3, 0xb4, 0xc5, 0xd6];
  await client.sendCheckIn(MESH_BROADCAST_ID, followers.slice(0, 1));
  assert.deepEqual(transport.targets, [MESH_BROADCAST_ID]);
  assert.equal(client.getState().checkIns[followers[0]].status, "waiting");
  for (const id of followers) {
    await client.parseData({ type: "live", text: "OK", fromId: id });
  }
  for (const id of followers) {
    assert.equal(client.getState().checkIns[id].status, "ok");
    assert.ok(client.getState().followers.some((follower) => follower.id === id));
  }
  await client.disconnect();
});

it("shows a plain OK from its sender without a previous check-in entry", async () => {
  const client = new ExcursionAppClient();
  const transport = new ScriptedTransport();
  await client.connectDevice("beacon", transport);
  await client.parseData({ type: "live", text: "OK", fromId: 0xa3 });
  await client.parseData({ type: "live", text: "OK later", fromId: 0xb4 });
  assert.equal(client.getState().checkIns[0xa3]?.status, "ok");
  assert.ok(client.getState().followers.some((follower) => follower.id === 0xa3));
  assert.equal(client.getState().checkIns[0xb4], undefined);
  await client.disconnect();
});
