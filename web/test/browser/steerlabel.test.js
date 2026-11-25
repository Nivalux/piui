// @ts-check

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { idle, openFreshChat, page, readCommands, start, stop } from "./harness.mjs";

before(start);
after(stop);

/** @returns {Promise<string | null>} */
function stripTag() {
  return page.evaluate(() => document.querySelector("#queue .queued .tag")?.textContent ?? null);
}

/**
 * @param {() => boolean} done
 */
async function until(done) {
  for (let at = 0; at < 120; at += 1) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * @param {string} id
 * @param {any} command
 */
async function post(id, command) {
  return page.evaluate(
    async (/** @type {{chat: string, body: string}} */ sent) =>
      (await fetch(`/api/cmd?id=${encodeURIComponent(sent.chat)}`, { method: "POST", body: sent.body })).status,
    { chat: id, body: JSON.stringify(command) },
  );
}

test("a chat that is not working never calls the next line steering", async () => {
  await openFreshChat();
  await idle();
  await page.fill("#input", "give me a long answer");
  await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#tab-list .tab.active .spinner") !== null, undefined, {
    timeout: 15000,
  });

  await openFreshChat();
  assert.equal(await stripTag(), null, "a chat with nothing on its way shows no queue strip");

  await page.fill("#input", "a line in the fresh chat");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#queue .queued").length > 0, undefined, {
    timeout: 15000,
  });
  assert.equal(await stripTag(), "on its way", "nothing is being steered in a chat that is not working");

  const sent = [...readCommands()].reverse().find((c) => c.type === "prompt" || c.type === "steer");
  assert.equal(sent?.type, "prompt", "a line typed into a settled chat starts a run of its own");

  await idle();
  await page.waitForFunction(() => document.getElementById("queue")?.hidden === true, undefined, { timeout: 15000 });
});

test("a steer aimed at a chat that already settled starts a run rather than waiting forever", async () => {
  const id = await openFreshChat();
  await idle();
  const before = readCommands().length;

  assert.ok((await post(id, { type: "steer", message: "a steer into a quiet chat" })) < 400);

  const landed = await until(() => {
    const last = [...readCommands().slice(before)]
      .reverse()
      .find((c) => c.type === "prompt" || c.type === "steer" || c.type === "follow_up");
    return last?.message === "a steer into a quiet chat" && last?.type === "prompt";
  });
  assert.ok(landed, "pi was asked to start a run, not to hold a thought for a turn that is over");
});
