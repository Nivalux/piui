// @ts-check

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { idle, openProjectChat, page, runTurn, start, stop, wiredProject } from "./harness.mjs";

before(start);
after(stop);

/** @returns {Promise<{title: string, cwd: string}>} */
function headline() {
  return page.evaluate(() => ({
    title: document.querySelector("#transcript .block.tool .title")?.textContent ?? "",
    cwd: document.getElementById("tab-cwd")?.textContent ?? "",
  }));
}

test("a tool line tells its path from the folder the chat runs in", async () => {
  await openProjectChat(wiredProject);
  await idle();

  await runTurn("write it out");
  await idle();

  const seen = await headline();
  assert.ok(seen.cwd.length > 0, "the chat runs somewhere");
  assert.equal(seen.title, "./big.js", `told from the folder, not spelled out: ${seen.title}`);

  await page.reload();
  await page.waitForSelector("#transcript .block.tool", { timeout: 30000 });
  assert.equal((await headline()).title, "./big.js", "a chat put back from storage reads the same");
});
