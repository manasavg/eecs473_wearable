import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Mesh, Portnums } from "@meshtastic/protobufs";
import { MeshSession } from "./session.ts";

function fromRadio(payloadVariant: Mesh.FromRadio["payloadVariant"]): Uint8Array {
  return toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { payloadVariant }));
}

describe("MeshSession", () => {
  it("reads the connected node and the other node's position", () => {
    const session = new MeshSession();
    const now = 1_700_000_000_000;
    const mine = fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) });
    const self = fromRadio({
      case: "nodeInfo",
      value: create(Mesh.NodeInfoSchema, {
        num: 0x11,
        position: create(Mesh.PositionSchema, { latitudeI: 42_280_0000, longitudeI: -83_740_0000 }),
        lastHeard: Math.floor(now / 1000),
      }),
    });
    const other = fromRadio({
      case: "nodeInfo",
      value: create(Mesh.NodeInfoSchema, {
        num: 0xa3,
        position: create(Mesh.PositionSchema, { latitudeI: 42_281_0000, longitudeI: -83_740_0000 }),
        lastHeard: Math.floor(now / 1000),
      }),
    });
    assert.deepEqual(session.ingest(mine, now), []);
    const selfEvents = session.ingest(self, now);
    assert.equal(selfEvents[0]?.type, "live");
    if (selfEvents[0]?.type !== "live") return;
    assert.equal(selfEvents[0].gps?.fix, true);
    const otherEvents = session.ingest(other, now);
    const card = otherEvents.find((event) => event.type === "live" && event.followerGps?.id === 0xa3);
    assert.ok(card && card.type === "live");
    if (card.type !== "live") return;
    assert.equal(card.followerGps?.fix, true);
    assert.ok((card.separation?.meters ?? 0) > 100);
    assert.ok((card.separation?.meters ?? 0) < 130);
  });

  it("treats an OK text as the follower reply", () => {
    const session = new MeshSession();
    session.ingest(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 1 }) }));
    const packet = create(Mesh.MeshPacketSchema, {
      from: 0xa3,
      to: 0xffffffff,
      payloadVariant: {
        case: "decoded",
        value: create(Mesh.DataSchema, {
          portnum: Portnums.PortNum.TEXT_MESSAGE_APP,
          payload: new TextEncoder().encode("OK"),
        }),
      },
    });
    const events = session.ingest(fromRadio({ case: "packet", value: packet }));
    assert.equal(events[0]?.type, "live");
    if (events[0]?.type !== "live") return;
    assert.equal(events[0].text, "OK");
    assert.equal(events[0].okId, 0xa3);
  });

  it("ignores a node that arrived from the public internet", () => {
    const session = new MeshSession();
    const now = 1_700_000_000_000;
    session.ingest(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }), now);
    const events = session.ingest(
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
      now,
    );
    assert.equal(events.some((event) => event.type === "live" && event.followerGps), false);
  });

  it("uses the radio's name and accepts its delivery receipt as OK", () => {
    const session = new MeshSession();
    const now = 1_700_000_000_000;
    session.ingest(fromRadio({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) }), now);
    const heard = session.ingest(
      fromRadio({
        case: "nodeInfo",
        value: create(Mesh.NodeInfoSchema, {
          num: 0xa3,
          lastHeard: Math.floor(now / 1000),
          user: create(Mesh.UserSchema, { longName: "Follower A3", shortName: "A3" }),
        }),
      }),
      now,
    );
    const card = heard.find((event) => event.type === "live" && event.followerGps?.id === 0xa3);
    assert.ok(card && card.type === "live");
    if (card.type !== "live") return;
    assert.equal(card.followerGps?.name, "Follower A3");

    const sent = session.checkInPackets();
    assert.equal(sent.length, 1);
    const toRadio = fromBinary(Mesh.ToRadioSchema, sent[0]);
    assert.equal(toRadio.payloadVariant.case, "packet");
    if (toRadio.payloadVariant.case !== "packet") return;
    const packetId = toRadio.payloadVariant.value.id;
    const ack = create(Mesh.MeshPacketSchema, {
      from: 0xa3,
      to: 0x11,
      payloadVariant: {
        case: "decoded",
        value: create(Mesh.DataSchema, {
          portnum: Portnums.PortNum.ROUTING_APP,
          requestId: packetId,
          payload: toBinary(
            Mesh.RoutingSchema,
            create(Mesh.RoutingSchema, {
              variant: { case: "errorReason", value: Mesh.Routing_Error.NONE },
            }),
          ),
        }),
      },
    });
    const events = session.ingest(fromRadio({ case: "packet", value: ack }), now);
    assert.equal(events[0]?.type, "live");
    if (events[0]?.type !== "live") return;
    assert.equal(events[0].okId, 0xa3);
  });
});
