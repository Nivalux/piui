// @ts-check

/** Browser tests about a server that stops answering. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { blocked, crashes, idle, openFreshChat, page, start, stop } from "./harness.mjs";

before(start);
after(stop);

const HELD = ["**/api/health**", "**/api/tabs**", "**/api/pty**", "**/api/sessions**"];

test("a page whose reads never come back asks once at a time", { skip: blocked, timeout: 90000 }, async () => {
  await openFreshChat();
  await idle();

  /** @type {Map<string, number>} */
  const waiting = new Map();
  let peak = 0;
  let worst = "";

  /** @param {any} route */
  const hold = async (route) => {
    const path = new URL(route.request().url()).pathname;
    const now = (waiting.get(path) ?? 0) + 1;
    waiting.set(path, now);
    if (now > peak) {
      peak = now;
      worst = path;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    waiting.set(path, now - 1);
    await route.abort().catch(() => {});
  };

  for (const pattern of HELD) await page.route(pattern, hold);

  try {
    await new Promise((resolve) => setTimeout(resolve, 9000));
    assert.equal(peak, 1, `one read of a kind waits at a time, saw ${peak} of ${worst}`);
  } finally {
    for (const pattern of HELD) await page.unroute(pattern);
  }

  await page.waitForFunction(() => document.getElementById("offline")?.hidden === true, undefined, {
    timeout: 15000,
  });
  assert.deepEqual(crashes, []);
});
