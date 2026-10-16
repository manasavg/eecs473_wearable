import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventsFromNotify, isFollowerOkSignal, parseLiveNotify } from "./live-link.ts";
import { encodeFollower, encodeLeader } from "./protocol.ts";
import { Status, type FollowerInfo } from "./types.ts";

describe("parseLiveNotify", () => {
  it("reads the OK the leader notifies after a follower button press", () => {
    const sample = parseLiveNotify(new TextEncoder().encode("OK"));
    assert.equal(sample.text, "OK");
    assert.equal(sample.counter, null);
    assert.equal(isFollowerOkSignal(sample.text), true);
    assert.equal(isFollowerOkSignal("OK 2"), true);
    assert.equal(isFollowerOkSignal("CHECK IN"), false);
  });

  it("reads the one-byte counter the sketch notifies every 3 seconds", () => {
    const sample = parseLiveNotify(new Uint8Array([7]));
    assert.equal(sample.counter, 7);
    assert.equal(sample.hex, "07");
    assert.equal(sample.text, null);
    assert.equal(sample.follower, null);
  });

  it("reads the little-endian counter the sketch notifies every 500 ms", () => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, 42, true);
    const sample = parseLiveNotify(bytes);
    assert.equal(sample.counter, 42);
    assert.equal(sample.hex, "2a 00 00 00");
    assert.equal(sample.text, null);
    assert.equal(sample.follower, null);
  });

  it("does not treat the counter as an alert, even when the first byte is version 1", () => {
    const sample = parseLiveNotify(new Uint8Array([0x01, 0x00, 0x00, 0x00]));
    assert.equal(sample.counter, 1);
    assert.equal(sample.follower, null);
  });

  it("reads the string stored in setup()", () => {
    const bytes = new TextEncoder().encode("Data successfully transmitted");
    const sample = parseLiveNotify(bytes);
    assert.equal(sample.text, "Data successfully transmitted");
    assert.equal(sample.counter, null);
  });

  it("drops a trailing NUL on that string", () => {
    const text = new TextEncoder().encode("Data successfully transmitted");
    const bytes = new Uint8Array(text.length + 1);
    bytes.set(text);
    assert.equal(parseLiveNotify(bytes).text, "Data successfully transmitted");
  });

  it("decodes a 9-byte follower on the same characteristic", () => {
    const info: FollowerInfo = {
      deviceId: 1,
      status: Status.OK,
      batteryPercent: 80,
      distanceM: 12.5,
      angleDeg: -30,
      uwbOutOfRange: false,
    };
    const sample = parseLiveNotify(encodeFollower(info));
    assert.equal(sample.follower?.deviceId, 1);
    assert.equal(sample.follower?.distanceM, 12.5);
    assert.equal(sample.counter, null);
  });

  it("decodes a 3-byte leader battery packet", () => {
    const sample = parseLiveNotify(encodeLeader({ batteryPercent: 86 }));
    assert.equal(sample.leaderBattery, 86);
    assert.equal(sample.distanceM, null);
  });

  it("reads the 3-byte UWB distance the leader notifies", () => {
    const sample = parseLiveNotify(new Uint8Array([0x44, 0xd2, 0x04]));
    assert.equal(sample.distanceM, 12.34);
    assert.equal(sample.counter, null);
    assert.equal(sample.text, null);
    assert.equal(sample.leaderBattery, null);
    assert.equal(sample.follower, null);
    const [event] = eventsFromNotify(new Uint8Array([0x44, 0xd2, 0x04]));
    assert.equal(event.type, "live");
    if (event.type === "live") assert.equal(event.distanceM, 12.34);
  });

  it("does not treat a counter or an OK as a distance", () => {
    assert.equal(parseLiveNotify(new Uint8Array([0x44])).distanceM, null);
    assert.equal(parseLiveNotify(new TextEncoder().encode("OK")).distanceM, null);
    assert.equal(parseLiveNotify(new Uint8Array([7])).distanceM, null);
  });
});
