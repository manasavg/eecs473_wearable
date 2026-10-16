import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BROADCAST_ID, PACKET_VERSION } from "./constants.ts";
import {
  ANGLE_SIGN,
  decodeAlert,
  decodeCommand,
  decodeFollower,
  decodeLeader,
  encodeAlert,
  encodeCommand,
  encodeFollower,
  encodeLeader,
} from "./protocol.ts";
import { CmdType, Status, type FollowerInfo } from "./types.ts";

const sample: FollowerInfo = {
  deviceId: 1,
  status: Status.OK,
  batteryPercent: 80,
  distanceM: 12.5,
  angleDeg: -30,
  uwbOutOfRange: false,
};

describe("command packets", () => {
  it("starts a group check-in with 1 so the Heltec sketch sends LoRa CHECK IN", () => {
    const bytes = encodeCommand({
      type: CmdType.CHECK_IN,
      targetId: BROADCAST_ID,
      thresholdMeters: 0,
    });
    assert.equal(bytes[0], 1);
  });

  it("encodes a check-in to wristband 2 as four bytes", () => {
    assert.deepEqual(
      [...encodeCommand({ type: CmdType.CHECK_IN, targetId: 2, thresholdMeters: 0 })],
      [PACKET_VERSION, CmdType.CHECK_IN, 2, 0],
    );
  });

  it("encodes a group threshold of 25 m", () => {
    const bytes = encodeCommand({
      type: CmdType.SET_THRESHOLD,
      targetId: BROADCAST_ID,
      thresholdMeters: 25,
    });
    assert.deepEqual([...bytes], [PACKET_VERSION, CmdType.SET_THRESHOLD, 0xff, 25]);
    assert.equal(decodeCommand(bytes).thresholdMeters, 25);
  });

  it("clamps the separation line to the UWB ceiling", () => {
    const bytes = encodeCommand({
      type: CmdType.SET_THRESHOLD,
      targetId: BROADCAST_ID,
      thresholdMeters: 80,
    });
    assert.equal(bytes[3], 40);
  });
});

describe("follower packets", () => {
  it("matches the known little-endian vector", () => {
    assert.equal(ANGLE_SIGN, 1, "Update PROTOCOL.md if you flip ANGLE_SIGN.");
    // 12.5 m → 1250 cm → E2 04.  -30° → -3000 cdeg → 48 F4.
    assert.deepEqual([...encodeFollower(sample)], [1, 1, 0, 80, 0xe2, 0x04, 0x48, 0xf4, 0]);
  });

  it("round-trips a fix, an unknown fix, and a longer future packet", () => {
    const decoded = decodeFollower(encodeFollower(sample));
    assert.deepEqual(decoded, sample);

    const lost = encodeFollower({
      ...sample,
      deviceId: 2,
      status: Status.OUT_OF_RANGE,
      batteryPercent: null,
      distanceM: null,
      angleDeg: null,
      uwbOutOfRange: true,
    });
    const lostInfo = decodeFollower(lost);
    assert.equal(lostInfo.distanceM, null);
    assert.equal(lostInfo.angleDeg, null);
    assert.equal(lostInfo.batteryPercent, null);
    assert.equal(lostInfo.uwbOutOfRange, true);

    const extended = new Uint8Array([...lost, 0xab]);
    assert.equal(decodeFollower(extended).deviceId, 2);
  });

  it("rejects a version the app does not know", () => {
    const bytes = encodeFollower(sample);
    bytes[0] = 9;
    assert.throws(() => decodeFollower(bytes), /version 9/);
  });
});

describe("leader and alert packets", () => {
  it("round-trips leader battery", () => {
    assert.deepEqual([...encodeLeader({ batteryPercent: 86 })], [1, 86, 0]);
    assert.equal(decodeLeader(encodeLeader({ batteryPercent: null })).batteryPercent, null);
  });

  it("round-trips a need-help alert", () => {
    const bytes = encodeAlert({
      deviceId: 2,
      status: Status.NEED_HELP,
      uwbOutOfRange: false,
    });
    assert.deepEqual([...bytes], [1, 2, Status.NEED_HELP, 0]);
    assert.equal(decodeAlert(bytes).status, Status.NEED_HELP);
  });
});
