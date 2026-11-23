// @ts-check

/** Browser tests about unread. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { blocked, crashes, idle, openFreshChat, page, runTurn, start, stop, switchTo } from "./harness.mjs";

before(start);
after(stop);

test("a chat that finishes in the background asks to be read", { skip: blocked }, async () => {
  /** @returns {Promise<any[]>} */
  const infos = async () => page.evaluate(() => fetch("/api/tabs").then((r) => r.json()));

  const here = (await infos()).map((info) => String(info.id));
  await page.click("#new-chat");
  await page.waitForTimeout(400);
  const other = (await infos()).map((info) => String(info.id)).find((id) => !here.includes(id));
  assert.ok(other, "a second chat should exist");

  await page.click(`#tab-list .tab[data-tab="${here[0]}"]`);
  await page.evaluate(
    async (/** @type {string} */ id) =>
      fetch(`/api/cmd?id=${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "prompt", message: "run the scripted tools" }),
      }),
    other,
  );

  await page.waitForFunction(
    async (/** @type {string} */ id) => {
      /** @type {any[]} */
      const list = await fetch("/api/tabs").then((r) => r.json());
      const info = list.find((t) => String(t.id) === id);
      return Boolean(info && !info.running && info.finishedMs > 0);
    },
    other,
    { timeout: 20000 },
  );

  const marked = `#tab-list .tab.unread[data-tab="${other}"]`;
  await page.waitForSelector(marked, { timeout: 12000 });
  assert.equal(
    await page
      .locator(`#tab-list .tab[data-tab="${here[0]}"]`)
      .evaluate((/** @type {any} */ row) => row.classList.contains("unread")),
    false,
  );

  await page.click(`#tab-list .tab[data-tab="${other}"]`);
  await page.waitForSelector(`#tab-list .tab.unread[data-tab="${other}"]`, { state: "detached", timeout: 5000 });
});

test("only what finished out of sight waits to be read", { skip: blocked }, async () => {
  /** The server's own word that a chat has run and settled, not the page's stale copy of it. */
  const finished = async (/** @type {string} */ id) =>
    page.waitForFunction(
      async (/** @type {string} */ chat) => {
        const found = await (await fetch("/api/tabs")).json();
        const tabs = /** @type {{id: string, running: boolean, finishedMs: number}[]} */ (found);
        const tab = tabs.find((row) => row.id === chat);
        return tab !== undefined && !tab.running && tab.finishedMs > 0;
      },
      id,
      { timeout: 30000 },
    );

  /** A chat nobody is watching is only heard about when the list is next read. */
  const marked = async (/** @type {string} */ id, /** @type {boolean} */ want) => {
    const looking_for = want ? "unread" : "read";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const now = await page
        .locator(`#tab-list .tab[data-tab="${id}"]`)
        .evaluate((/** @type {HTMLElement} */ row) => (row.classList.contains("unread") ? "unread" : "read"));
      if (now === looking_for) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };

  const watched = await openFreshChat();
  await runTurn("answer briefly");
  await finished(watched);

  const other = await openFreshChat();
  await idle();
  await page.fill("#input", "a steady stream");
  await page.click("#send");
  await switchTo(watched);

  assert.ok(await marked(other, true), "the chat that ended after the reader left it waits to be read");
  assert.ok(await marked(watched, false), "this one answered while it was on the screen");
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
