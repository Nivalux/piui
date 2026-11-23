// @ts-check

/** Browser tests about message. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  blocked,
  clipboardHolds,
  crashes,
  gitProject,
  hold,
  idle,
  openProjectChat,
  page,
  readCommands,
  runTurn,
  start,
  stop,
  toastSays,
} from "./harness.mjs";

before(start);
after(stop);

async function actionsOf(/** @type {import("playwright").Locator} */ block) {
  return await block
    .locator(".msg-actions button")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
}

/** @param {import("playwright").Locator} row */
const copyRow = (row) => row.locator('[aria-label="copy message"]');

/** @param {import("playwright").Locator} row */
const forkRow = (row) => row.locator('[aria-label="fork here"]');

test("a message hands its text to the clipboard", { skip: blocked }, async () => {
  await openProjectChat(gitProject);
  await runTurn("please remember piui-copy-1");

  const asked = page.locator("#transcript .block.user", { hasText: "piui-copy-1" }).last();
  assert.deepEqual(await actionsOf(asked), ["copy message", "fork here"]);

  await hold("");
  await copyRow(asked).click();
  await clipboardHolds("please remember piui-copy-1");
  await toastSays(/Copied/);
});

test("an answer hands over the text as it was written", { skip: blocked }, async () => {
  const answer = page.locator("#transcript .block.text").last();
  assert.deepEqual(await actionsOf(answer), ["copy message", "fork here"]);

  await hold("");
  await copyRow(answer).click();
  await clipboardHolds("**Beide Tools**");
  await clipboardHolds("piui-fake-write.txt");
});

test("a folded line keeps its buttons inside the fold", { skip: blocked }, async () => {
  const tool = page.locator("#transcript .block.tool").first();

  assert.equal(await tool.locator("> .msg-actions").count(), 0, "nothing hangs under a folded line");
  const inside = tool.locator("details .fold-body .msg-actions");
  assert.equal(await inside.count(), 1);
  assert.equal(await inside.isVisible(), false, "shut with the fold it is in");

  await tool.locator("details summary").click();
  assert.equal(await inside.isVisible(), true, "open with it");

  await hold("");
  await copyRow(inside).click();
  await clipboardHolds("sleep 2 && echo done");
});

test("forking a message cuts the chat back to where it was asked", { skip: blocked }, async () => {
  await idle();
  const asked = page.locator("#transcript .block.user", { hasText: "piui-copy-1" }).first();
  await forkRow(asked).click();

  await page.waitForFunction(
    () =>
      document.querySelectorAll("#transcript .block.user").length === 1 &&
      document.querySelectorAll("#transcript .block.text").length === 0,
    undefined,
    { timeout: 10000 },
  );
  assert.match(
    await page.locator("#transcript .block.user").innerText(),
    /piui-copy-1/,
    "the chat carries on from the message it was forked at",
  );
  await toastSays(/Forked/);

  const sent = readCommands().filter((/** @type {{type?: string}} */ frame) => frame.type === "fork");
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].entryId), /^e\d+$/, "pi was told which message to start from");
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
