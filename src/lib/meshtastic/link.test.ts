import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Mesh, Portnums } from "@meshtastic/protobufs";
import type { BleEvent } from "../ble/transport.ts";
import { MeshLink } from "./link.ts";

function fromRadio(payloadVariant: Mesh.FromRadio["payloadVariant"]): Uint8Array {
  return toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { payloadVariant }));
}

async function listen(): Promise<{ link: MeshLink; events: BleEvent[]; writes: Uint8Array[] }> {
  const events: BleEvent[] = [];
  const writes: Uint8Array[] = [];
  const link = new MeshLink(
    async (bytes) => {
      writes.push(bytes);
    },
    (event) => events.push(event),
  );
  return { link, events, writes };
}

function routing(from: number, requestId: number, errorReason: number): Uint8Array {
  const payload = toBinary(
    Mesh.RoutingSchema,
    create(Mesh.RoutingSchema, { variant: { case: "errorReason", value: errorReason } }),
  );
  return fromRadio({
    case: "packet",
    value: create(Mesh.MeshPacketSchema, {
      from,
      to: 0x11,
      id: 1234,
      payloadVariant: {
        case: "decoded",
        value: create(Mesh.DataSchema, { portnum: Portnums.PortNum.ROUTING_APP, requestId, payload }),
      },
    }),
  });
}

function nodeA3(): Uint8Array {
  return fromRadio({
    case: "nodeInfo",
    value: create(Mesh.NodeInfoSchema, {
      num: 0xa3,
      lastHeard: Math.floor(Date.now() / 1000) - 60,
      user: create(Mesh.UserSchema, { longName: "Follower A3", shortName: "A3" }),
    }),
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("MeshLink", () => {
  it("reads the connected node and the other node's position", async () => {
    const { link, events } = await listen();
    const now = Date.now();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(
      fromRadio({
        case: "nodeInfo",
        value: create(Mesh.NodeInfoSchema, {
          num: 0x11,
          position: create(Mesh.PositionSchema, { latitudeI: 42_280_0000, longitudeI: -83_740_0000 }),
          lastHeard: Math.floor(now / 1000),
        }),
      }),
    );
    link.push(
      fromRadio({
        case: "nodeInfo",
        value: create(Mesh.NodeInfoSchema, {
          num: 0xa3,
          position: create(Mesh.PositionSchema, { latitudeI: 42_281_0000, longitudeI: -83_740_0000 }),
          lastHeard: Math.floor(now / 1000),
          user: create(Mesh.UserSchema, { longName: "Follower A3", shortName: "A3" }),
        }),
      }),
    );
    await settle();
    assert.equal(events.some((event) => event.type === "live" && event.gps?.fix === true), true);
    const card = events.find((event) => event.type === "live" && event.followerGps?.id === 0xa3);
    assert.ok(card && card.type === "live");
    if (card.type !== "live") return;
    assert.equal(card.followerGps?.name, "Follower A3");
    assert.equal(card.followerGps?.fix, true);
    assert.equal(events.some((event) => event.type === "live" && event.followerGps?.id === 0x11), false);
  });

  it("ignores a node that arrived from the public internet", async () => {
    const { link, events } = await listen();
    const now = Date.now();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(
      fromRadio({
        case: "nodeInfo",
        value: create(Mesh.NodeInfoSchema, {
          num: 0x99,
          viaMqtt: true,
          lastHeard: Math.floor(now / 1000),
          user: create(Mesh.UserSchema, { longName: "Someone far away", shortName: "SF" }),
          position: create(Mesh.PositionSchema, { latitudeI: 40_000_0000, longitudeI: -70_000_0000 }),
        }),
      }),
    );
    await settle();
    assert.equal(events.some((event) => event.type === "live" && event.followerGps), false);
  });

  it("asks Meshtastic to send CHECK IN", async () => {
    const { link, writes } = await listen();
    await link.sendCheckIn(0xa3);
    assert.equal(writes.length, 1);
    const { fromBinary } = await import("@bufbuild/protobuf");
    const toRadio = fromBinary(Mesh.ToRadioSchema, writes[0]);
    assert.equal(toRadio.payloadVariant.case, "packet");
    if (toRadio.payloadVariant.case !== "packet") return;
    assert.equal(toRadio.payloadVariant.value.payloadVariant.case, "decoded");
    if (toRadio.payloadVariant.value.payloadVariant.case !== "decoded") return;
    const text = new TextDecoder().decode(toRadio.payloadVariant.value.payloadVariant.value.payload);
    assert.equal(text, "CHECK IN");
  });

  it("counts a check-in only when the target board acknowledges it", async () => {
    const { link, events } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(nodeA3());
    await settle();
    const packetId = await link.sendCheckIn(0xa3);
    assert.ok(events.some((event) => event.type === "checkin-sent" && event.packetId === packetId));
    // The leader's own acknowledgement only means another radio repeated it.
    link.push(routing(0x11, packetId, Mesh.Routing_Error.NONE));
    await settle();
    assert.equal(events.some((event) => event.type === "checkin-ack"), false);
    link.push(routing(0xa3, packetId, Mesh.Routing_Error.NONE));
    await settle();
    const ack = events.find((event) => event.type === "checkin-ack");
    assert.ok(ack && ack.type === "checkin-ack");
    assert.equal(ack.id, 0xa3);
    assert.equal(ack.packetId, packetId);
  });

  it("reports No answer when the radio gives up", async () => {
    const { link, events } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(nodeA3());
    await settle();
    const packetId = await link.sendCheckIn(0xa3);
    link.push(routing(0x11, packetId, Mesh.Routing_Error.MAX_RETRANSMIT));
    await settle();
    const failed = events.filter((event) => event.type === "checkin-failed");
    assert.equal(failed.length, 1);
    const first = failed[0];
    assert.ok(first.type === "checkin-failed");
    assert.equal(first.id, 0xa3);
    assert.equal(first.noAnswer, true);
  });

  it("marks a known board heard on any packet and carries the database time", async () => {
    const { link, events } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(nodeA3());
    await settle();
    const card = events.find((event) => event.type === "live" && event.followerGps?.id === 0xa3);
    assert.ok(card && card.type === "live");
    const heardAt = card.followerGps?.heardAt ?? 0;
    assert.ok(Date.now() - heardAt >= 59_000 && Date.now() - heardAt < 62_000);
    link.push(routing(0xa3, 999, Mesh.Routing_Error.NONE));
    await settle();
    assert.ok(events.some((event) => event.type === "heard" && event.id === 0xa3));
  });

  it("rejects a check-in when the Bluetooth write fails instead of waiting forever", async () => {
    const link = new MeshLink(
      async () => {
        throw new Error("GATT write failed");
      },
      () => undefined,
    );
    await assert.rejects(() => link.sendCheckIn(0xa3), /GATT write failed/);
  });

  it("reads a Detection Sensor OK press with its bell character as OK", async () => {
    const { link, events } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(
      fromRadio({
        case: "packet",
        value: create(Mesh.MeshPacketSchema, {
          from: 0xa3,
          to: 0xffffffff,
          id: 4321,
          payloadVariant: {
            case: "decoded",
            value: create(Mesh.DataSchema, {
              portnum: Portnums.PortNum.TEXT_MESSAGE_APP,
              payload: new TextEncoder().encode("\u0007OK detected"),
            }),
          },
        }),
      }),
    );
    await settle();
    const ok = events.find((event) => event.type === "live" && event.okId === 0xa3);
    assert.ok(ok && ok.type === "live");
    assert.equal(ok.text, "OK detected");
  });

  it("adds a board from any packet before it sends a position", async () => {
    const { link, events } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(routing(0xb4, 1, Mesh.Routing_Error.NONE));
    await settle();
    const seen = events.find((event) => event.type === "node-seen");
    assert.ok(seen && seen.type === "node-seen");
    assert.equal(seen.id, 0xb4);
    assert.ok(events.some((event) => event.type === "my-node" && event.id === 0x11));
  });

  it("shows a board again once it is heard after being stale", async () => {
    const { link, events } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(
      fromRadio({
        case: "nodeInfo",
        value: create(Mesh.NodeInfoSchema, {
          num: 0xa3,
          lastHeard: Math.floor(Date.now() / 1000) - 8 * 60 * 60,
          user: create(Mesh.UserSchema, { longName: "Follower A3", shortName: "A3" }),
        }),
      }),
    );
    await settle();
    assert.equal(events.some((event) => event.type === "live" && event.followerGps?.id === 0xa3), false);
    link.push(routing(0xa3, 2, Mesh.Routing_Error.NONE));
    await settle();
    assert.ok(events.some((event) => event.type === "node-seen" && event.id === 0xa3));
  });

  it("turns a Detection Sensor packet from the OK button into a press", async () => {
    const { link, events } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(
      fromRadio({
        case: "packet",
        value: create(Mesh.MeshPacketSchema, {
          from: 0x19e8,
          to: 0xffffffff,
          id: 5555,
          payloadVariant: {
            case: "decoded",
            value: create(Mesh.DataSchema, {
              portnum: Portnums.PortNum.DETECTION_SENSOR_APP,
              payload: new TextEncoder().encode("OK detected"),
            }),
          },
        }),
      }),
    );
    await settle();
    const press = events.find((event) => event.type === "ok-press");
    assert.ok(press && press.type === "ok-press");
    assert.equal(press.id, 0x19e8);
    assert.equal(press.text, "OK detected");
  });

  it("does not read 'not ok' as an OK reply", async () => {
    const { isOkText } = await import("./link.ts");
    assert.equal(isOkText("OK"), true);
    assert.equal(isOkText("ok detected"), true);
    assert.equal(isOkText("not ok"), false);
    assert.equal(isOkText("okay"), false);
  });

  it("still counts an acknowledgement that arrives after a reconnect", async () => {
    const pending = new Map<number, number>();
    const first: BleEvent[] = [];
    const before = new MeshLink(async () => undefined, (event) => first.push(event), pending);
    before.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    before.push(nodeA3());
    await settle();
    const packetId = await before.sendCheckIn(0xa3);

    // The Bluetooth link drops; the transport builds a new link with the same map.
    const second: BleEvent[] = [];
    const after = new MeshLink(async () => undefined, (event) => second.push(event), pending);
    after.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    after.push(nodeA3());
    after.push(routing(0xa3, packetId, Mesh.Routing_Error.NONE));
    await settle();
    assert.ok(second.some((event) => event.type === "checkin-ack" && event.packetId === packetId));
  });

  it("reads press and release from the button, and SOS as an emergency", async () => {
    const { buttonEdge, isEmergencyText } = await import("./link.ts");
    assert.equal(buttonEdge("OK state: 1"), "press");
    assert.equal(buttonEdge("OK state: 0"), "release");
    assert.equal(buttonEdge("OK detected"), "press");
    assert.equal(buttonEdge("hello"), null);
    assert.equal(isEmergencyText("SOS"), true);
    assert.equal(isEmergencyText("help me"), true);
    assert.equal(isEmergencyText("no help needed"), false);
  });
});
