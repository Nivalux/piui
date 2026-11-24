// @ts-check

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { blocked, idle, openFreshChat, page, start, stop } from "./harness.mjs";

before(start);
after(stop);

/**
 * Start a turn that keeps working for a while, so the next line typed is
 * steering rather than a chat of its own.
 *
 * @param {string} text
 */
async function busyWith(text) {
  await idle();
  await page.fill("#input", text);
  await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#tab-list .tab.active .spinner") !== null, undefined, {
    timeout: 15000,
  });
}

/**
 * Send a second line into the chat that is already working.
 *
 * @param {string} text
 */
async function steer(text) {
  await page.fill("#input", text);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (/** @type {string} */ want) =>
      [...document.querySelectorAll("#queue .queued")].some((row) => row.textContent?.includes(want)),
    text,
    { timeout: 15000 },
  );
}

function pullButton() {
  return page.waitForSelector("#queue button", { timeout: 15000 });
}

function editorText() {
  return page.$eval("#input", (/** @type {HTMLTextAreaElement} */ box) => box.value);
}

test("a thought still on its way is not lost by pulling the queue", { skip: blocked }, async () => {
  await openFreshChat();
  await busyWith("give me a long answer");
  await steer("a second thought");
  await pullButton();
  await page.click("#queue button");
  await page.waitForFunction(
    () => document.querySelector("#input")?.value.includes("a second thought") === true,
    undefined,
    { timeout: 15000 },
  );
  assert.ok((await editorText()).includes("a second thought"));
  await idle();
});

test("a thought pi never acknowledged comes back instead of vanishing", { skip: blocked }, async () => {
  await openFreshChat();
  await busyWith("give me a long answer");
  await steer("an unconfirmed thought");
  await pullButton();
  await page.click("#queue button");
  await page.waitForFunction(
    () => document.querySelector("#input")?.value.includes("an unconfirmed thought") === true,
    undefined,
    { timeout: 15000 },
  );
  assert.ok((await editorText()).includes("an unconfirmed thought"));
  await idle();
});

test("the button to pull a thought back outlives the tokens arriving beside it", { skip: blocked }, async () => {
  await openFreshChat();
  await busyWith("stream the answer");
  await steer("a second thought");
  await page.waitForSelector("#queue button", { timeout: 15000 });

  const held = await page.evaluate(async () => {
    const touched = document.querySelector("#queue button");
    const words = document.querySelector("#transcript")?.textContent?.length ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 700));
    return {
      arriving: (document.querySelector("#transcript")?.textContent?.length ?? 0) > words,
      same: touched !== null && touched === document.querySelector("#queue button") && touched.isConnected,
    };
  });

  assert.ok(held.arriving, "an answer was really arriving while the button was watched");
  assert.ok(held.same, "the button under a hand that pressed it is still there to release on");
  await idle();
});
