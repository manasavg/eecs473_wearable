import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bearingDegrees,
  cardinalLabel,
  guideCue,
  headingFromOrientation,
  isOutOfRange,
  relativeBearing,
} from "./geo.ts";

describe("bearing", () => {
  it("points north when the follower is due north", () => {
    const bearing = bearingDegrees(42, -83, 43, -83);
    assert.ok(bearing < 1 || bearing > 359);
  });

  it("points east when the follower is due east", () => {
    const bearing = bearingDegrees(0, 0, 0, 1);
    assert.ok(Math.abs(bearing - 90) < 1);
  });

  it("turns the phone heading into a relative arrow", () => {
    assert.equal(relativeBearing(90, 0), 90);
    assert.equal(relativeBearing(10, 20), 350);
  });

  it("names the cardinal and the turn", () => {
    assert.equal(cardinalLabel(0), "N");
    assert.equal(cardinalLabel(90), "E");
    assert.equal(guideCue(0), "Straight ahead");
    assert.equal(guideCue(90), "Turn right");
    assert.equal(guideCue(270), "Turn left");
  });
});

describe("range", () => {
  it("is out only when the distance is known and past the limit", () => {
    assert.equal(isOutOfRange(true, 41, 40), true);
    assert.equal(isOutOfRange(true, 40, 40), false);
    assert.equal(isOutOfRange(true, 12, 40), false);
    assert.equal(isOutOfRange(false, 80, 40), false);
    assert.equal(isOutOfRange(null, null, 40), false);
  });
});

describe("compass", () => {
  it("prefers the iOS compass heading", () => {
    assert.equal(headingFromOrientation({ webkitCompassHeading: 12, alpha: 180, absolute: true }), 12);
  });

  it("uses alpha when the compass heading is missing", () => {
    assert.equal(headingFromOrientation({ alpha: 90, absolute: true }), 270);
  });
});
