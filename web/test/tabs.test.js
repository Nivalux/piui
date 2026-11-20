// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import { byActivity, byRun, isUnread, splitTabs, stamp } from "../tabs.js";

/**
 * @param {Partial<import("../protocol.js").TabInfo>} over
 * @returns {import("../protocol.js").TabInfo}
 */
function tab(over) {
  return {
    id: "t1",
    cwd: "/work/a",
    project: false,
    running: false,
    closed: false,
    createdMs: 1_000,
    lastOutputMs: 1_000,
    ...over,
  };
}

test("a working chat holds its place while it streams", () => {
  const shape = [
    tab({ id: "quiet", running: true, runStartedMs: 5_000, lastOutputMs: 2_000 }),
    tab({ id: "loud", running: true, runStartedMs: 4_000, lastOutputMs: 9_000 }),
    tab({ id: "done", running: false, lastOutputMs: 8_000 }),
  ];

  const { working, settled } = splitTabs(shape);
  assert.deepEqual(working.map((item) => item.id), ["quiet", "loud"], "the run that began most recently leads");
  assert.deepEqual(settled.map((item) => item.id), ["done"]);

  const later = splitTabs([
    tab({ id: "quiet", running: true, runStartedMs: 5_000, lastOutputMs: 99_000 }),
    tab({ id: "loud", running: true, runStartedMs: 4_000, lastOutputMs: 9_000 }),
    tab({ id: "done", running: false, lastOutputMs: 8_000 }),
  ]);
  assert.deepEqual(later.working.map((item) => item.id), ["quiet", "loud"], "more output moves nobody");
});

test("a working chat with no run yet keeps the order it was opened in", () => {
  const list = [
    tab({ id: "old", running: true, createdMs: 1_000, lastOutputMs: 9_000 }),
    tab({ id: "new", running: true, createdMs: 2_000, lastOutputMs: 3_000 }),
  ];

  assert.deepEqual(byRun(list).map((item) => item.id), ["new", "old"]);
  assert.deepEqual(byRun(list).map((item) => item.id), ["new", "old"], "and again, identically");
});

test("a settled chat is sorted by what it did last", () => {
  const { settled } = splitTabs([
    tab({ id: "older", lastOutputMs: 5_000, finishedMs: 4_000 }),
    tab({ id: "newer", lastOutputMs: 3_000, finishedMs: 7_000 }),
  ]);

  assert.deepEqual(settled.map((item) => item.id), ["newer", "older"]);
});

test("a chat that never spoke still has a place", () => {
  assert.equal(stamp(tab({ lastOutputMs: 0, finishedMs: 0, createdMs: 42 })), 42);
  assert.deepEqual(
    byActivity([tab({ id: "b", lastOutputMs: 0, createdMs: 0 }), tab({ id: "a", lastOutputMs: 1, createdMs: 0 })]).map(
      (t) => t.id,
    ),
    ["a", "b"],
  );
});

test("a run that ended elsewhere is unread", () => {
  const seen = { t1: 5_000 };
  assert.equal(isUnread(tab({ finishedMs: 9_000 }), seen, "other"), true);
  assert.equal(isUnread(tab({ finishedMs: 4_000 }), seen, "other"), false);
  assert.equal(isUnread(tab({ finishedMs: 9_000 }), seen, "t1"), false, "the reader is already in it");
  assert.equal(isUnread(tab({ finishedMs: 9_000, running: true }), seen, "other"), false, "still going");
  assert.equal(isUnread(tab({ finishedMs: 0 }), {}, "other"), false, "nothing has ever finished");
});
