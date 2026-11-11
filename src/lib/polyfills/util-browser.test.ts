import assert from "node:assert/strict";
import test from "node:test";
import util from "./util-browser.cjs";

test("browser util can format Meshtastic log arguments", () => {
  assert.equal(typeof util.formatWithOptions, "function");
  assert.equal(typeof util.inspect, "function");
  assert.equal(util.formatWithOptions({ colors: false }, "CHECK IN", 17), "CHECK IN 17");
});
