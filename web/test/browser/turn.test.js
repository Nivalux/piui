// @ts-check

/** Browser tests about turn. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { blocked, crashes, page, start, stop } from "./harness.mjs";

before(start);
after(stop);

test("a turn draws thoughts, tools and an answer", { skip: blocked }, async () => {
  await page.click("#new-chat");
  await page.fill("#input", "run the scripted tools");
  await page.click("#send");

  await page.waitForSelector("#transcript .block.text >> text=Beide Tools");
  const kinds = await page
    .locator("#transcript .block")
    .evaluateAll((/** @type {Element[]} */ rows) => rows.map((row) => String(row.className.replace("block ", ""))));
  assert.ok(kinds.includes("thinking"), "thoughts should be a row of their own");
  assert.equal(kinds.filter((/** @type {string} */ kind) => kind === "tool").length, 4);
});

test("with thinking turned off the line stays and only the words beside it go", { skip: blocked }, async () => {
  await page.click("#new-chat");
  await page.fill("#input", "run the scripted tools");
  await page.click("#send");
  await page.waitForSelector("#transcript .block.text >> text=Beide Tools");

  const thoughts = () =>
    page.locator("#transcript .block.thinking").evaluateAll((/** @type {Element[]} */ rows) =>
      rows.map((row) => ({
        line: (row.querySelector("summary")?.textContent ?? "").trim(),
        preview: row.querySelector("summary .title")?.textContent ?? "",
        words: (row.querySelector(".thinking-body")?.textContent ?? "").trim(),
      })),
    );

  const toggle = async () => {
    await page.click("#settings-button");
    await page.click(".setting.thinking input");
    await page.click("#settings-modal .button.primary");
  };

  await toggle();

  const kept = await thoughts();
  assert.ok(kept.length > 0, "the turn did think");
  for (const row of kept) {
    assert.equal(row.line, "thoughts", "the line stays where the thought was");
    assert.equal(row.preview, "", "and nothing is read beside it");
    assert.ok(row.words.length > 0, "opened, the thought is still there");
  }

  await toggle();

  assert.ok(
    (await thoughts()).every((/** @type {{preview: string}} */ row) => row.preview.length > 0),
    "turned back on, the words come back beside the line",
  );
});

test("clicking a running tool opens it and keeps it open", { skip: blocked }, async () => {
  await page.fill("#input", "and now the long one");
  await page.click("#send");

  const row = page.locator("#transcript .block.tool", { hasText: "sleep 6" }).first();
  await row.locator(".spinner").waitFor({ state: "visible", timeout: 10000 });
  const summary = row.locator("details > summary");

  await summary.click();
  assert.equal(
    await row.locator("details").evaluate((/** @type {any} */ fold) => fold.open),
    true,
    "the click should open it",
  );

  // The row is rewritten as output arrives; that must not close it again.
  await page.waitForTimeout(1300);
  assert.equal(
    await row.locator("details").evaluate((/** @type {any} */ fold) => fold.open),
    true,
    "streaming must not close it",
  );

  const open = await row.locator(".fold-body").innerText();
  assert.match(open, /tick /, "an open call shows the output as it arrives");
  assert.match(open, /timeout/, "and every argument it was given");
  assert.match(await row.locator(".state").innerText(), /^\d+\.\ds$/, "and counts the seconds it waits");

  // The clocks count up where they stand, so their boxes may not grow with the
  // digits: the tool line and the footer would step sideways as seconds roll
  // over. Each is measured with a short reading and a wide one, which is what
  // the reserved width is for.
  const clock = () =>
    page.evaluate(() => {
      const widthWith = (/** @type {Element} */ node, /** @type {string} */ text) => {
        const held = node.textContent;
        node.textContent = text;
        const width = node.getBoundingClientRect().width;
        node.textContent = held;
        return width;
      };
      const tick = /** @type {HTMLElement} */ (document.querySelector(".block details > summary .tick"));
      const busy = /** @type {HTMLElement} */ (document.querySelector("#busy-time"));
      return {
        tick: [widthWith(tick, "9.4s"), widthWith(tick, "1h 02m")],
        busy: [widthWith(busy, "9.4s"), widthWith(busy, "1h 02m")],
        text: `${tick.textContent}|${busy.textContent}`,
      };
    });
  /** A character of drift is what this guards; a fraction of one is rounding. */
  const keepsWidth = (/** @type {[number, number]} */ pair, /** @type {string} */ where) =>
    assert.ok(Math.abs(pair[0] - pair[1]) < 1, `${where} keeps its width whatever it shows: ${JSON.stringify(pair)}`);

  const clockAtStart = await clock();
  keepsWidth(clockAtStart.tick, "the tool clock");
  keepsWidth(clockAtStart.busy, "the footer clock");

  // The row is rewritten many times a second. A spinner that starts its turn at
  // zero on every rewrite only jitters, so each one begins at the angle the
  // clock already reached. The spinner in the composer is never rebuilt: hold
  // the two against each other and they keep step.
  const steps = await page.evaluate(async () => {
    /** Where in its turn a spinner stands, in ms, whatever it was built at. */
    const angle = (/** @type {Element} */ node) => {
      const face = /matrix\(([-\d.]+), ([-\d.]+)/.exec(getComputedStyle(node).transform);
      if (!face) return 0;
      const deg = (Math.atan2(Number(face[2]), Number(face[1])) * 180) / Math.PI;
      return ((((deg % 360) + 360) % 360) / 360) * 750;
    };

    /** @type {[number, number][]} */
    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      const live = document.querySelector("#transcript .block.tool .spinner");
      if (live) seen.push([angle(live), performance.now()]);
      await new Promise((resolve) => setTimeout(resolve, 320));
    }
    return seen;
  });
  const clockAtEnd = await clock();
  assert.notEqual(clockAtEnd.text, clockAtStart.text, "the clocks count on");
  keepsWidth(clockAtEnd.tick, "the tool clock");
  keepsWidth(clockAtEnd.busy, "the footer clock");

  /** @type {[number, number][]} */
  const turns = steps;
  assert.ok(turns.length >= 4, "a spinner turns while the tool runs");
  const [first, atFirst] = turns[0];
  const worst = Math.max(
    ...turns.map(([angle, at]) => {
      const behind = Math.abs((((angle - first - (at - atFirst)) % 750) + 750) % 750);
      return Math.min(behind, 750 - behind);
    }),
  );
  assert.ok(
    worst < 150,
    `the spinner keeps turning with the clock rather than starting over: ${turns.map(([angle, at]) => Math.round(angle - at))}`,
  );

  await row.locator(".spinner").waitFor({ state: "detached", timeout: 20000 });
  assert.equal(
    await row.locator("details").evaluate((/** @type {any} */ fold) => fold.open),
    true,
    "finishing must not close it",
  );
  assert.match(await summary.innerText(), /6\.\ds/, "a finished row says how long it ran");
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
