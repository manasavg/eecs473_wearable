import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MISSED_PINGS_LIMIT, SUSTAINED_OVER_THRESHOLD_CYCLES } from "./constants.ts";
import { decideRange, type RangeInput } from "./ranging.ts";
import { Status } from "./types.ts";

function input(overrides: Partial<RangeInput> = {}): RangeInput {
  return {
    distanceM: 12,
    angleDeg: 10,
    missedPings: 0,
    overThresholdCount: 0,
    thresholdM: 40,
    needHelp: false,
    checkInPending: false,
    ...overrides,
  };
}

describe("decideRange", () => {
  it("ignores a single reading past the line", () => {
    const once = decideRange(input({ distanceM: 30, thresholdM: 20 }));
    assert.equal(once.status, Status.OK);
    assert.equal(once.overThresholdCount, 1);
    assert.equal(once.distanceM, 30);
  });

  it("alerts once the sustained filter fills, and keeps the fix", () => {
    let over = 0;
    let decision = decideRange(input({ distanceM: 30, thresholdM: 20, overThresholdCount: over }));
    for (let i = 1; i < SUSTAINED_OVER_THRESHOLD_CYCLES; i += 1) {
      over = decision.overThresholdCount;
      decision = decideRange(input({ distanceM: 30, thresholdM: 20, overThresholdCount: over }));
    }
    assert.equal(decision.status, Status.OUT_OF_RANGE);
    assert.equal(decision.uwbOutOfRange, false);
    assert.equal(decision.distanceM, 30);
    assert.equal(decision.angleDeg, 10);
  });

  it("resets the filter when the hiker steps back", () => {
    const back = decideRange(
      input({ distanceM: 10, thresholdM: 20, overThresholdCount: 2 }),
    );
    assert.equal(back.overThresholdCount, 0);
    assert.equal(back.status, Status.OK);
  });

  it("holds through nine missed UWB pings and drops the fix on the tenth", () => {
    const holding = decideRange(input({ missedPings: MISSED_PINGS_LIMIT - 1 }));
    assert.equal(holding.status, Status.OK);
    assert.equal(holding.uwbOutOfRange, false);

    const lost = decideRange(input({ missedPings: MISSED_PINGS_LIMIT, distanceM: 40, angleDeg: 5 }));
    assert.equal(lost.status, Status.OUT_OF_RANGE);
    assert.equal(lost.uwbOutOfRange, true);
    assert.equal(lost.distanceM, null);
    assert.equal(lost.angleDeg, null);
  });

  it("keeps Need Help above a check-in, and a check-in above out-of-range", () => {
    const help = decideRange(
      input({ needHelp: true, checkInPending: true, missedPings: MISSED_PINGS_LIMIT }),
    );
    assert.equal(help.status, Status.NEED_HELP);
    assert.equal(help.uwbOutOfRange, true);

    const pending = decideRange(
      input({ checkInPending: true, missedPings: MISSED_PINGS_LIMIT }),
    );
    assert.equal(pending.status, Status.CHECKIN_PENDING);
  });
});
