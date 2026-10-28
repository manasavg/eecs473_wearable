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
    assert.equal(sample.gps, null);
  });

  it("reads the 10-byte GPS fix the leader notifies", () => {
    const sample = parseLiveNotify(gpsPacket(true, 42.5, -83.25));
    assert.equal(sample.gps?.fix, true);
    assert.equal(sample.gps?.lat, 42.5);
    assert.equal(sample.gps?.lon, -83.25);
    assert.equal(sample.counter, null);
    assert.equal(sample.text, null);
    assert.equal(sample.leaderBattery, null);
    assert.equal(sample.follower, null);
    const [event] = eventsFromNotify(gpsPacket(true, 42.5, -83.25));
    assert.equal(event.type, "live");
    if (event.type === "live") {
      assert.equal(event.gps?.fix, true);
      assert.equal(event.gps?.lat, 42.5);
      assert.equal(event.gps?.lon, -83.25);
    }
  });

  it("reads a GPS packet with no lock", () => {
    const sample = parseLiveNotify(gpsPacket(false, 0, 0));
    assert.equal(sample.gps?.fix, false);
    assert.equal(sample.gps?.lat, null);
    assert.equal(sample.gps?.lon, null);
  });

  it("does not treat a counter or an OK as a GPS fix", () => {
    assert.equal(parseLiveNotify(new Uint8Array([0x47])).gps, null);
    assert.equal(parseLiveNotify(new TextEncoder().encode("OK")).gps, null);
    assert.equal(parseLiveNotify(new Uint8Array([7])).gps, null);
  });

  it("reads the 5-byte distance the leader notifies", () => {
    const bytes = separationPacket(12.34);
    const sample = parseLiveNotify(bytes);
    assert.equal(sample.separation?.known, true);
    assert.equal(sample.separation?.meters, 12.34);
    assert.equal(sample.gps, null);
    assert.equal(sample.text, null);
    const [event] = eventsFromNotify(bytes);
    assert.equal(event.type, "live");
    if (event.type === "live") assert.equal(event.separation?.meters, 12.34);
  });

  it("reads the follower fix the leader notifies", () => {
    const sample = parseLiveNotify(positionPacket(0x46, true, 42.33, -83.04));
    assert.equal(sample.followerGps?.fix, true);
    assert.equal(sample.followerGps?.lat, 42.33);
    assert.equal(sample.followerGps?.lon, -83.04);
    assert.equal(sample.gps, null);
    const [event] = eventsFromNotify(positionPacket(0x46, false, 0, 0));
    assert.equal(event.type, "live");
    if (event.type === "live") {
      assert.equal(event.followerGps?.fix, false);
      assert.equal(event.gps, null);
    }
  });

  it("reads a distance packet with no fix", () => {
    const sample = parseLiveNotify(new Uint8Array([0x4d, 0xff, 0xff, 0xff, 0xff]));
    assert.equal(sample.separation?.known, false);
    assert.equal(sample.separation?.meters, null);
  });
});

function separationPacket(meters: number): Uint8Array {
  const bytes = new Uint8Array(5);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x4d;
  view.setUint32(1, Math.round(meters * 100), true);
  return bytes;
}

function gpsPacket(fix: boolean, lat: number, lon: number): Uint8Array {
  return positionPacket(0x47, fix, lat, lon);
}

function positionPacket(marker: number, fix: boolean, lat: number, lon: number): Uint8Array {
  const bytes = new Uint8Array(10);
  const view = new DataView(bytes.buffer);
  bytes[0] = marker;
  bytes[1] = fix ? 1 : 0;
  view.setInt32(2, Math.round(lat * 1e7), true);
  view.setInt32(6, Math.round(lon * 1e7), true);
  return bytes;
}
