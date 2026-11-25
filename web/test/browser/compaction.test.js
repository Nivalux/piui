// @ts-check

/** Browser tests about a chat that comes back already compacted. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { blocked, crashes, page, sessionsDir, start, stop, wiredProject, writeSession } from "./harness.mjs";

before(start);
after(stop);

test("a chat that comes back compacted says where it began", { skip: blocked }, async () => {
  writeSession(path.join(sessionsDir, "2026-11-08T00-00-00-000Z_compacted.jsonl"), {
    cwd: wiredProject,
    first: "narrow the hub after the summary",
    header: "2026-11-06T00:00:00.000Z",
    last: "2026-11-08T09:00:00.000Z",
    compaction: {
      summary: "Earlier: the hub owns every pi and the page only watches.",
      tokensBefore: 114904,
      at: "2026-11-07T09:00:00.000Z",
    },
  });

  await page.reload();
  await page.waitForSelector("#session-list .session");
  await page.locator("#session-list .session", { hasText: "narrow the hub after the summary" }).click();
  await page.waitForSelector("#transcript .block", { timeout: 15000 });

  const kinds = await page.evaluate(() =>
    [...document.querySelectorAll("#transcript .block")].map((node) => [...node.classList].pop()),
  );
  assert.deepEqual(kinds, ["user", "compaction", "text"], "the chat does not begin where the summary ends");

  const block = page.locator("#transcript .block.compaction");
  assert.match(await block.innerText(), /114904 tokens compacted/);

  await block.locator("> details > summary").click();
  await page.waitForFunction(
    () => (document.querySelector("#transcript .block.compaction .fold-body")?.textContent ?? "").length > 0,
  );
  assert.match(
    await block.locator(".fold-body").innerText(),
    /the hub owns every pi/,
    "what the compaction kept is readable",
  );
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
