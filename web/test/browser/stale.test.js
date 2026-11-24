// @ts-check

/** Browser tests about a queue row the chat has already outgrown. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { blocked, crashes, openFreshChat, page, start, stop } from "./harness.mjs";

process.env.PIUI_FAKE_QUEUE = "stuck";

before(start);
after(stop);

const wanted = "will not let go";

/**
 * A chat that keeps working, so the next line typed is steering.
 *
 * @param {string} text
 */
async function busyWith(text) {
  await page.fill("#input", text);
  await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#tab-list .tab.active .spinner") !== null, undefined, {
    timeout: 15000,
  });
}

/**
 * @param {string} want
 * @returns {boolean}
 */
function held(want) {
  return [...document.querySelectorAll("#queue .queued")].some((row) => row.textContent?.includes(want));
}

test("a thought the chat already shows leaves the strip, though Pi still names it", { skip: blocked }, async () => {
  await openFreshChat();
  await busyWith("hold the run and stream");

  await page.fill("#input", `a thought pi ${wanted} of`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(held, wanted, { timeout: 15000 });

  await page.waitForFunction(
    (want) => [...document.querySelectorAll("#transcript .block.user")].some((row) => row.textContent?.includes(want)),
    wanted,
    { timeout: 15000 },
  );
  // Asked about at that very moment, while the run is still streaming: a strip
  // that only clears itself when the run settles has not learned anything.
  assert.ok(!(await page.evaluate(held, wanted)), "a chat that shows the words does not keep them waiting below");
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
