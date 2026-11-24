import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Mesh, Portnums } from "@meshtastic/protobufs";
import { ExcursionAppClient } from "../ble/app-client.ts";
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

  it("keeps the newest position for the leader and four followers across partial packets and stale replay", async () => {
    const client = new ExcursionAppClient();
    const link = new MeshLink(async () => undefined, (event) => { void client.parseData(event); });
    const timestamp = Math.floor(Date.now() / 1000);
    const leader = 0x11;
    const followers = [0xa3, 0xb4, 0xc5, 0xd6];
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: leader }) }));
    for (const id of [leader, ...followers]) {
      const latitudeI = 422_810_000 + id;
      link.push(fromRadio({
        case: "nodeInfo",
        value: create(Mesh.NodeInfoSchema, {
          num: id,
          position: create(Mesh.PositionSchema, { latitudeI, longitudeI: -837_400_000, timestamp }),
        }),
      }));
      const updates = [
        { time: timestamp },
        { timestamp: timestamp + 1, locationSource: Mesh.Position_LocSource.LOC_INTERNAL },
        { latitudeI: 0, longitudeI: 0 },
        { latitudeI: 410_000_000, longitudeI: -830_000_000, timestamp: timestamp - 60, time: timestamp + 1 },
      ];
      for (const [index, position] of updates.entries()) {
        link.push(fromRadio({
          case: "packet",
          value: create(Mesh.MeshPacketSchema, {
            from: id,
            id: index + 1,
            payloadVariant: {
              case: "decoded",
              value: create(Mesh.DataSchema, {
                portnum: Portnums.PortNum.POSITION_APP,
                payload: toBinary(Mesh.PositionSchema, create(Mesh.PositionSchema, position)),
              }),
            },
          }),
        }));
      }
    }
    await settle();
    assert.equal(client.getState().gpsLat, (422_810_000 + leader) / 1e7);
    assert.deepEqual(
      client.getState().followers.map(({ id, fix, lat }) => [id, fix, lat]),
      followers.map((id) => [id, true, (422_810_000 + id) / 1e7]),
    );
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
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(nodeA3());
    await settle();
    await link.sendCheckIn(0xa3);
    assert.equal(writes.length, 1);
    const { fromBinary } = await import("@bufbuild/protobuf");
    const toRadio = fromBinary(Mesh.ToRadioSchema, writes[0]);
    assert.equal(toRadio.payloadVariant.case, "packet");
    if (toRadio.payloadVariant.case !== "packet") return;
    assert.equal(toRadio.payloadVariant.value.to, 0xa3);
    assert.equal(toRadio.payloadVariant.value.wantAck, true);
    assert.equal(toRadio.payloadVariant.value.payloadVariant.case, "decoded");
    if (toRadio.payloadVariant.value.payloadVariant.case !== "decoded") return;
    const text = new TextDecoder().decode(toRadio.payloadVariant.value.payloadVariant.value.payload);
    assert.equal(text, "CHECK IN");
  });

  it("sends one primary-channel broadcast for a group check-in", async () => {
    const { link, writes } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    await settle();
    await link.sendCheckIn(0xffffffff);
    assert.equal(writes.length, 1);
    const { fromBinary } = await import("@bufbuild/protobuf");
    const { payloadVariant } = fromBinary(Mesh.ToRadioSchema, writes[0]);
    assert.equal(payloadVariant.case, "packet");
    if (payloadVariant.case !== "packet") return;
    assert.equal(payloadVariant.value.to, 0xffffffff);
    assert.equal(payloadVariant.value.channel, 0);
    assert.equal(payloadVariant.value.wantAck, false);
    const decoded = payloadVariant.value.payloadVariant;
    assert.equal(decoded.case, "decoded");
    if (decoded.case === "decoded") assert.equal(new TextDecoder().decode(decoded.value.payload), "CHECK IN");
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
    const discovered = events.find((event) => event.type === "node-seen" && event.id === 0xa3);
    assert.ok(discovered?.type === "node-seen");
    const heardAt = discovered.at ?? 0;
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
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(nodeA3());
    await settle();
    await assert.rejects(() => link.sendCheckIn(0xa3), /GATT write failed/);
  });

  it("reads the Wearable firmware’s direct OK and NEED HELP replies", async () => {
    const { link, events } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(nodeA3());
    await settle();
    const texts = [[0xffffffff, "OK"], [0x11, "OK"], [0x11, "NEED HELP\x07"]] as const;
    for (const [to, text] of texts) {
      link.push(fromRadio({
        case: "packet",
        value: create(Mesh.MeshPacketSchema, {
          from: 0xa3, to,
          payloadVariant: {
            case: "decoded",
            value: create(Mesh.DataSchema, {
              portnum: Portnums.PortNum.TEXT_MESSAGE_APP,
              payload: new TextEncoder().encode(text),
            }),
          },
        }),
      }));
    }
    await settle();
    const replies = events.flatMap((event) =>
      event.type === "live" && event.fromId === 0xa3 ? [event.text] : [],
    );
    assert.deepEqual(replies, ["OK", "NEED HELP"]);
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

  it("shows all four reported followers when switching leaders, regardless of name, age, hops, or fix", async () => {
    const ids = [0x11, 0xa3, 0xb4, 0xc5, 0xd6];
    const now = Math.floor(Date.now() / 1000);
    for (const leader of [ids[0], ids[1]]) {
      const client = new ExcursionAppClient();
      const link = new MeshLink(async () => undefined, (event) => { void client.parseData(event); });
      for (const [index, id] of ids.entries()) {
        link.push(fromRadio({
          case: "nodeInfo",
          value: create(Mesh.NodeInfoSchema, {
            num: id,
            hopsAway: 3,
            lastHeard: now - 8 * 60 * 60,
            ...(index === 1 ? { user: create(Mesh.UserSchema, { longName: "Custom Name" }) } : {}),
            ...(index === 2 ? { position: create(Mesh.PositionSchema, { time: now }) } : {}),
          }),
        }));
      }
      await settle();
      assert.deepEqual(client.getState().followers, []);
      link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: leader }) }));
      await settle();
      assert.deepEqual(client.getState().followers.map((node) => node.id), ids.filter((id) => id !== leader));
      assert.ok(client.getState().followers.every((node) => node.fix !== true));
      if (leader !== 0xa3) {
        assert.equal(client.getState().followers.find((node) => node.id === 0xa3)?.name, "Custom Name");
      }
    }
  });

  it("discovers a node when it hears a local packet after an MQTT-only record", async () => {
    const { link, events } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    link.push(fromRadio({
      case: "nodeInfo",
      value: create(Mesh.NodeInfoSchema, { num: 0xa3, viaMqtt: true }),
    }));
    const packet = create(Mesh.MeshPacketSchema, {
      from: 0xa3, viaMqtt: true, hopStart: 6, hopLimit: 2,
      payloadVariant: {
        case: "decoded",
        value: create(Mesh.DataSchema, {
          portnum: Portnums.PortNum.POSITION_APP,
          payload: toBinary(Mesh.PositionSchema, create(Mesh.PositionSchema, {
            latitudeI: 42_281_0000, longitudeI: -83_740_0000,
          })),
        }),
      },
    });
    link.push(fromRadio({ case: "packet", value: packet }));
    await settle();
    assert.equal(events.some((event) => event.type === "node-seen"), false);
    assert.equal(events.some((event) => event.type === "live" && event.followerGps), false);

    link.push(fromRadio({ case: "packet", value: { ...packet, viaMqtt: false } }));
    await settle();
    assert.ok(events.some((event) => event.type === "node-seen" && event.id === 0xa3));
    assert.ok(events.some((event) => event.type === "live" && event.followerGps?.fix));
  });

  it("does not read 'not ok' as an OK reply", async () => {
    const { isOkText } = await import("./link.ts");
    assert.equal(isOkText("OK"), true);
    assert.equal(isOkText("ok detected"), false);
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


  it("reports no battery level for a board without battery sensing", async () => {
    const { Telemetry } = await import("@meshtastic/protobufs");
    const { link, events } = await listen();
    link.push(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }));
    const report = (batteryLevel: number, voltage: number) =>
      fromRadio({
        case: "packet",
        value: create(Mesh.MeshPacketSchema, {
          from: 0xa3,
          to: 0xffffffff,
          id: 77,
          payloadVariant: {
            case: "decoded",
            value: create(Mesh.DataSchema, {
              portnum: Portnums.PortNum.TELEMETRY_APP,
              payload: toBinary(
                Telemetry.TelemetrySchema,
                create(Telemetry.TelemetrySchema, {
                  variant: {
                    case: "deviceMetrics",
                    value: create(Telemetry.DeviceMetricsSchema, { batteryLevel, voltage }),
                  },
                }),
              ),
            }),
          },
        }),
      });
    link.push(report(0, 0));
    link.push(report(87, 4.0));
    await settle();
    const batteries = events.filter((event) => event.type === "battery");
    assert.equal(batteries.length, 2);
    assert.equal(batteries[0].type === "battery" && batteries[0].percent, null);
    assert.equal(batteries[1].type === "battery" && batteries[1].percent, 87);
  });
});
