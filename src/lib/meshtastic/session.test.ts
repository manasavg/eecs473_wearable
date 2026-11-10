import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
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
});
