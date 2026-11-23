// @ts-check

/** Browser tests about a chat whose pi is gone. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { activeTab, blocked, crashes, openFreshChat, page, runTurn, start, stop } from "./harness.mjs";

before(start);
after(stop);

/**
 * Close a chat from the outside, the way the server does when it lets a chat that has been quiet
 * for half an hour go.
 *
 * @param {string} id
 */
async function closeChat(id) {
  await page.evaluate(
    async (/** @type {string} */ chat) =>
      void (await fetch(`/api/tab?id=${encodeURIComponent(chat)}`, { method: "DELETE", credentials: "same-origin" })),
    id,
  );
  await page.waitForSelector(".chat-ended", { timeout: 15000 });
}

test("typing into a chat whose pi is gone wakes it, and the prompt survives", { skip: blocked }, async () => {
  const first = await openFreshChat();
  await closeChat(first);

  await runTurn("wake me up");

  assert.notEqual(await activeTab(), first, "the chat that woke up runs in a pi of its own");
  const asked = await page.locator("#transcript .block.user .body").allInnerTexts();
  assert.ok(
    asked.some((line) => line.includes("wake me up")),
    `the prompt is in the transcript: ${asked.join(" | ")}`,
  );
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
