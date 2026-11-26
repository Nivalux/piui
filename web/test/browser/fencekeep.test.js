// @ts-check

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { idle, openFreshChat, page, start, stop } from "./harness.mjs";

before(start);
after(stop);

test("a box that is finished keeps its button while the answer goes on", async () => {
  await openFreshChat();
  await idle();

  await page.fill("#input", "keep the fence");
  await page.click("#send");

  await page.waitForFunction(
    () => {
      const wrap = document.querySelector("#transcript .block.text .code-wrap");
      if (wrap === null) return false;
      wrap.dataset.tag = "kept";
      const button = wrap.querySelector("button");
      if (button !== null) button.dataset.tag = "kept";
      const actions = document.querySelector("#transcript .block.text .msg-actions");
      if (actions !== null) actions.dataset.tag = "kept";
      return true;
    },
    undefined,
    { timeout: 20000 },
  );

  await page.waitForFunction(
    () => (document.querySelector("#transcript .block.text .md")?.textContent ?? "").includes("ein Stuck"),
    undefined,
    { timeout: 20000 },
  );

  const kept = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("#transcript .block.text .code-wrap")];
    return {
      boxes: boxes.length,
      box: boxes[0]?.dataset.tag ?? "",
      button: boxes[0]?.querySelector("button")?.dataset.tag ?? "",
      actions: document.querySelector("#transcript .block.text .msg-actions")?.dataset.tag ?? "",
    };
  });

  assert.equal(kept.boxes, 1, "one code box, not one per arriving word");
  assert.equal(kept.box, "kept", "the box that was finished kept its place in the page");
  assert.equal(kept.button, "kept", "and the button beside it is still the same element");
  assert.equal(kept.actions, "kept", "the buttons under the answer were not rebuilt either");
});

test("a call that is still being written is not painted again for its arguments", async () => {
  await openFreshChat();
  await idle();

  await page.fill("#input", "write it out");
  await page.click("#send");

  await page.waitForSelector("#transcript .block.tool summary", { timeout: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 400));

  await page.evaluate(() => {
    const row = document.querySelector("#transcript .block.tool summary");
    if (row !== null) row.dataset.tag = "kept";
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const kept = await page.evaluate(() => {
    const block = document.querySelector("#transcript .block.tool");
    return {
      summary: block?.querySelector("summary")?.dataset.tag ?? "",
      title: block?.querySelector(".title")?.textContent ?? "",
    };
  });

  assert.equal(kept.title, "write", "still writing the call, so still streaming");
  assert.equal(kept.summary, "kept", "the row stood still while its arguments arrived");
});
