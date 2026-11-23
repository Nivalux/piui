// @ts-check

/** Browser tests about reconnect. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { base, blocked, crashes, idle, page, runTurn, start, stop } from "./harness.mjs";

before(start);
after(stop);

test("the ring follows the chat instead of sticking at its first number", { skip: blocked }, async () => {
  await runTurn("widen the window once");
  await page.waitForFunction(() => document.getElementById("context-pct")?.textContent === "71%", undefined, {
    timeout: 10000,
  });

  // A compaction leaves Pi without a count of its own until the next answer, and
  // the number from before it would be a lie about how full things are.
  await runTurn("widen the window again");
  await page.waitForFunction(() => document.getElementById("context")?.hidden === true, undefined, { timeout: 10000 });

  await runTurn("and widen it once more");
  await page.waitForFunction(() => document.getElementById("context-pct")?.textContent === "21%", undefined, {
    timeout: 10000,
  });
  await idle();
});

test("a server that goes away is said out loud, and the page comes back by itself", { skip: blocked }, async () => {
  const health = await (await fetch(`${base}/api/health`)).json();

  /** @type {"live" | "down" | "rebuilt"} */
  let mood = "live";
  await page.addInitScript(() => {
    try {
      const seen = Number(sessionStorage.getItem("piui-reloads") ?? 0);
      sessionStorage.setItem("piui-reloads", String(seen + 1));
    } catch {
      // A document with no storage to count in is a document that did not reload.
    }
  });
  const reloads = () =>
    page.waitForFunction(
      (/** @type {number} */ want) => Number(sessionStorage.getItem("piui-reloads") ?? 0) >= want,
      1,
      { timeout: 15000 },
    );
  await page.route("**/api/health", (/** @type {any} */ route) => {
    if (mood === "down") return route.abort("connectionrefused");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, signedIn: true, build: mood === "rebuilt" ? "f".repeat(16) : health.build }),
    });
  });

  try {
    mood = "down";
    await page.waitForSelector("#offline", { state: "visible", timeout: 15000 });
    assert.match(await page.locator("#offline").innerText(), /not reachable/);
    assert.equal(await page.locator("#transcript").count(), 1, "the chat stays on screen while the server is gone");

    mood = "live";
    await page.waitForSelector("#offline", { state: "hidden", timeout: 15000 });

    mood = "rebuilt";
    await reloads();

    // Hand the page its own build back and let it settle, or the next test
    // starts in the middle of a reload it knows nothing about.
    mood = "live";
    await page.waitForFunction(() => Number(sessionStorage.getItem("piui-reloads") ?? 0) >= 2, null, {
      timeout: 15000,
    });
    await page.waitForSelector("#new-chat", { state: "visible", timeout: 15000 });
  } finally {
    await page.unroute("**/api/health");
  }
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
