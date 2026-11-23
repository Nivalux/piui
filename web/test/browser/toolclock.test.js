// @ts-check

/** Browser tests about how long a tool says it took. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { blocked, crashes, idle, page, start, stop } from "./harness.mjs";

before(start);
after(stop);

test("a finished tool wears the length it reported", { skip: blocked }, async () => {
  await idle();
  const before = await page.locator("#transcript .block.tool").count();
  await page.fill("#input", "and once more with the write");
  await page.click("#send");
  await page.waitForFunction(
    (/** @type {number} */ count) => document.querySelectorAll("#transcript .block.tool").length > count + 2,
    before,
    { timeout: 30000 },
  );
  await idle();

  const row = page.locator("#transcript .block.tool", { hasText: "piui-fake-write.txt" }).first();
  assert.equal(
    await row.locator(".state").innerText(),
    "4.2s",
    "the tool's own number, not the gap between two frames",
  );
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
