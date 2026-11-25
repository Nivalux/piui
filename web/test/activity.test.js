import { test } from "node:test";
import assert from "node:assert/strict";
import { activityFrame, activityInterval } from "../activity.js";

test("activity advances at eight frames per second and wraps after ten frames", () => {
  assert.equal(activityInterval, 125);
  assert.equal(activityFrame(0), "⠋");
  assert.equal(activityFrame(124), "⠋");
  assert.equal(activityFrame(125), "⠙");
  assert.equal(activityFrame(1249), "⠏");
  assert.equal(activityFrame(1250), "⠋");
  assert.equal(new Set(Array.from({ length: 10 }, (_, i) => activityFrame(i * 125))).size, 10);
});
