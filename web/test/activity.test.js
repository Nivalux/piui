import { test } from "node:test";
import assert from "node:assert/strict";
import { activityFrame, activityInterval } from "../activity.js";

test("activity advances at four frames per second and wraps after ten frames", () => {
  assert.equal(activityInterval, 250);
  assert.equal(activityFrame(0), "⠋");
  assert.equal(activityFrame(249), "⠋");
  assert.equal(activityFrame(250), "⠙");
  assert.equal(activityFrame(2499), "⠏");
  assert.equal(activityFrame(2500), "⠋");
  assert.equal(new Set(Array.from({ length: 10 }, (_, i) => activityFrame(i * 250))).size, 10);
});
