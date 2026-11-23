// @ts-check

/** Browser tests about slash commands. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  activeTab,
  blocked,
  crashes,
  gitProject,
  openProjectChat,
  page,
  readCommands,
  sidebarIds,
  start,
  stop,
  toastSays,
  wiredProject,
} from "./harness.mjs";

before(start);
after(stop);

/**
 * The palette takes the first Enter to complete the name, so a command line needs a second one.
 *
 * @param {string} line
 */
async function typeLine(line) {
  await page.fill("#input", line);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
}

/**
 * A command leaves the page over HTTP, so the file the stand-in logs them to lags a moment behind.
 *
 * @param {(frames: {type?: string, message?: string, customInstructions?: string}[]) => boolean} want
 */
async function sawSent(want) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (want(readCommands())) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("the stand-in was never sent it");
}

test("a command of pi's own that needs its terminal never reaches the model", { skip: blocked }, async () => {
  await openProjectChat(gitProject);
  await typeLine("/settings");

  await toastSays(/pi's own/);
  assert.match(await page.inputValue("#input"), /^\/settings\s*$/, "the line stays where it can be fixed");
  assert.equal(
    readCommands().some((frame) => frame.type === "prompt"),
    false,
    "pi was never asked to answer it",
  );
});

test("an argument goes with the command it follows", { skip: blocked }, async () => {
  await typeLine("/compact keep the tests");
  await page.waitForFunction(() => /** @type {HTMLInputElement} */ (document.getElementById("input")).value === "");

  await sawSent((frames) => frames.some((frame) => frame.type === "compact"));
  const compacted = sent("compact");
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].customInstructions, "keep the tests");
});

test("something that only starts like a command is still a prompt", { skip: blocked }, async () => {
  await typeLine("/notacommand hello");

  await sawSent((frames) => frames.some((frame) => frame.type === "prompt" && frame.message === "/notacommand hello"));
});

test("reload reopens the chat on the file it was opened from", { skip: blocked }, async () => {
  await page.locator("#session-list .session-title", { hasText: "explain the pi wiring" }).first().click();
  await page.waitForFunction(
    /** @param {string} want */
    (want) => document.getElementById("tab-cwd")?.textContent === want,
    wiredProject,
    { timeout: 20000 },
  );
  const was = await activeTab();
  const tabs = await sidebarIds();

  await typeLine("/reload");
  await toastSays(/Reopened/);

  await page.waitForFunction(
    /** @param {string} gone */
    (gone) => !Array.from(document.querySelectorAll("#tab-list .tab")).some((node) => node.dataset.tab === gone),
    was,
    { timeout: 10000 },
  );
  const after = await sidebarIds();
  assert.equal(after.length, tabs.length, "one chat in, one chat out");
  assert.notEqual(await activeTab(), was, "the chat carries on in a tab of its own");

  await page.waitForSelector("#transcript .block.user", { hasText: "explain the pi wiring" });
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});

/** @param {string} type */
function sent(type) {
  return readCommands().filter((frame) => frame.type === type);
}
