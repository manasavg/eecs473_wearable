import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Mesh } from "@meshtastic/protobufs";
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
    await link.sendCheckIn();
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
});
