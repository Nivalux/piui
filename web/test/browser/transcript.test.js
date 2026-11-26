// @ts-check

/** Browser tests about transcript. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  activeTab,
  blocked,
  crashes,
  gap,
  gitProject,
  idle,
  openFreshChat,
  openProjectChat,
  overflow,
  page,
  present,
  readCommands,
  runTurn,
  start,
  stop,
  switchTo,
} from "./harness.mjs";

before(start);
after(stop);

/** The chat the scroll tests grew long enough to overflow. */
let longTab = "";

test("signing in lands in a chat with the composer in view", { skip: blocked }, async () => {
  assert.equal(await page.locator("#gate").count(), 0, "the token gate should be gone");
  assert.equal(await page.locator("#input").isVisible(), true);
  assert.equal(await page.locator("#send").isVisible(), true);
});

test("a picture a tool read is shown, and opens full size", { skip: blocked }, async () => {
  await page.click("#new-chat");
  await page.fill("#input", "run the scripted tools");
  await page.click("#send");
  await page.waitForSelector("#transcript .block.tool .shot .thumb");

  const shot = page.locator("#transcript .block.tool", { has: page.locator(".shot") }).first();

  // A closed tool line is where a picture is usually found, and a line saying
  // "[image image/png]" is not the picture.
  const open = await shot.locator("details").evaluate((/** @type {HTMLDetailsElement} */ fold) => fold.open);
  assert.equal(open, false, "the tool is closed");
  assert.ok(await shot.locator(".shot .thumb").isVisible(), "the picture is there with the tool closed");

  const text = await shot.evaluate((/** @type {HTMLElement} */ row) => row.textContent ?? "");
  assert.ok(!text.includes("[image image/png]"), "no placeholder stands in for the picture");

  const src = await shot
    .locator(".thumb")
    .evaluate((/** @type {HTMLImageElement} */ node) => node.getAttribute("src") ?? "");
  assert.ok(src.startsWith("data:image/png;base64,"), "the bytes pi sent are the bytes drawn");

  await shot.locator(".shot").click();
  await page.waitForFunction(() => !document.getElementById("lightbox")?.hasAttribute("hidden"));
  assert.equal(
    await page.evaluate(() => document.getElementById("lightbox-img")?.getAttribute("src") ?? ""),
    src,
    "the same picture, full size",
  );

  await page.keyboard.press("Escape");
  await page.waitForSelector("#lightbox", { state: "hidden" }, { timeout: 10000 });

  await shot.locator(".shot").click();
  await page.waitForFunction(() => !document.getElementById("lightbox")?.hasAttribute("hidden"));
  await page.click("#lightbox");
  await page.waitForSelector("#lightbox", { state: "hidden" }, { timeout: 10000 });
});

test("a thought is closed until the reader opens it", { skip: blocked }, async () => {
  const open = await page
    .locator("#transcript .block.thinking details")
    .evaluate((/** @type {any} */ fold) => fold.open);
  assert.equal(open, false);
});

test("every queued message is asked for at once", { skip: blocked }, async () => {
  await openFreshChat();

  await page.fill("#input", "what is in this folder");
  await page.click("#send");

  // The stand-in for pi only exists once a chat asked for it, and it writes
  // every command it is given as it goes.
  /** @type {any[]} */
  let seen = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    seen = readCommands();
    if (seen.some((entry) => entry.type === "set_steering_mode")) break;
    await page.waitForTimeout(150);
  }

  const asked = seen.find((entry) => entry.type === "set_steering_mode");
  assert.ok(asked, "set_steering_mode was never sent, so pi decides how many messages arrive at a time");
  assert.equal(asked.mode, "all", "two thoughts typed in a row are one instruction");

  // One mode at a time. Setting both would let a message the reader meant as a
  // steering word sit in a second queue with different rules on it.
  assert.equal(
    seen.some((entry) => entry.type === "set_follow_up_mode"),
    false,
    "the queue mode is not asked for while the setting says steer",
  );
});

test("thoughts typed into a running chat wait, and come back to the box", { skip: blocked }, async () => {
  // A chat of one's own: a tab another test left open, or already closed, is a
  // prompt that goes nowhere and a run that never starts.
  await openFreshChat();

  await page.fill("#input", "the long one");
  await page.click("#send");
  await page.locator("#transcript .block.tool .spinner").waitFor({ state: "visible", timeout: 20000 });

  await page.fill("#input", "also check the tests");
  await page.click("#send");
  await page.fill("#input", "and the readme");
  await page.click("#send");

  await page.waitForSelector('#queue .queued:has-text("also check the tests")');
  await page.waitForSelector('#queue .queued:has-text("and the readme")');

  const tags = await page.locator("#queue .queued .tag").allInnerTexts();
  assert.deepEqual([...new Set(tags)], ["steering"], "one mode, said the same way on every row");

  await page.click("#queue button");
  await page.waitForFunction(
    () => {
      const value = /** @type {HTMLTextAreaElement} */ (document.getElementById("input")).value;
      return value.includes("also check the tests") && value.includes("and the readme");
    },
    null,
    { timeout: 5000 },
  );

  assert.equal(await page.locator("#queue .queued").count(), 0, "the strip empties once they are back");
  await page.fill("#input", "");

  // Nothing is queued any more, so the model never sees them and the strip has
  // nothing left to say about this run.
  await page.waitForFunction(() => /** @type {HTMLElement} */ (document.getElementById("queue")).hidden, null, {
    timeout: 5000,
  });
});

test("the thinking line that is still streaming opens under the pointer", { skip: blocked }, async () => {
  await idle();
  await page.fill("#input", "a thoughtful answer please");
  await page.click("#send");

  await page.waitForFunction(
    (/** @type {string} */ name) =>
      [...document.querySelectorAll("#transcript .block.thinking .name")].some((n) => n.textContent === name),
    "thinking",
    { timeout: 10000 },
  );

  // Scrolling up unpins the newest line, so the row under the pointer stays put
  // for the length of the press. It is the situation the reader is in anyway:
  // the line worth opening is the one still filling up.
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(200);

  const box = await page.evaluate(() => {
    const block = [...document.querySelectorAll("#transcript .block.thinking")]
      .filter((node) => node.querySelector(".name")?.textContent === "thinking")
      .pop();
    /** @type {any} */ (window).__b = block;
    const rect = /** @type {any} */ (block)?.querySelector("summary")?.getBoundingClientRect();
    return rect ? { x: rect.x + 12, y: rect.y + rect.height / 2, open: block?.querySelector("details")?.open } : null;
  });
  assert.ok(box, "the live line has a place on the screen");
  assert.equal(box.open, false, "and it starts out closed");

  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();

  assert.equal(
    await page.evaluate(() => /** @type {any} */ (window).__b?.querySelector("details")?.open === true),
    true,
    "pressing the line that is streaming opens it",
  );

  await idle();
  const open = await page.evaluate(() => {
    const fold = /** @type {any} */ (window).__b?.querySelector("details");
    return { open: fold?.open === true, text: fold?.querySelector(".fold-body")?.textContent ?? "" };
  });
  assert.equal(open.open, true, "and it stays open once the answer is through");
  assert.match(open.text, /possible shape/, "showing everything thought so far");
});

test("a write says in its summary what it changed", { skip: blocked }, async () => {
  const row = page.locator("#transcript .block.tool", { hasText: "piui-fake-write.txt" }).first();
  assert.equal(await row.locator(".hint .add").innerText(), "+3");
  assert.equal(await row.locator(".hint .del").innerText(), "−0");
});

test("a failed call is marked red on the left", { skip: blocked }, async () => {
  const row = page.locator("#transcript .block.tool", { hasText: "missing.txt" }).first();
  assert.equal(
    await row.locator("details").evaluate((/** @type {any} */ fold) => fold.classList.contains("error")),
    true,
  );
  assert.equal(await row.locator(".flag").innerText(), "⚠");
  assert.equal(await row.locator(".state").innerText(), "failed");
});

test("an answer is laid out, not dumped", { skip: blocked }, async () => {
  const answer = page.locator("#transcript .block.text").last();
  assert.equal(await answer.locator("strong").innerText(), "Beide Tools");
  assert.equal(await answer.locator("li").count(), 2);
  assert.equal(await answer.locator("li code").innerText(), "piui-fake-write.txt");
});

test("scrolling up stops the follow, the arrow brings it back", { skip: blocked }, async () => {
  await openFreshChat();
  longTab = await activeTab();
  assert.ok(longTab.length > 0, "a chat is open");

  for (let turn = 0; turn < 2; turn += 1) await runTurn("make it tall");
  assert.ok((await overflow()) > 150, "two long answers overflow the transcript");
  assert.equal(await page.locator("#jump").isVisible(), false, "at the end there is nothing to jump to");

  await page.evaluate(() => {
    const box = /** @type {HTMLElement} */ (document.getElementById("transcript"));
    box.scrollTop = 0;
  });
  await page.waitForSelector("#jump", { timeout: 3000 });

  await idle();
  const before = await page.locator("#transcript .block.text").count();
  await page.fill("#input", "make it tall");
  await page.click("#send");
  await page.waitForFunction(
    (/** @type {number} */ count) => document.querySelectorAll("#transcript .block.text").length > count,
    before,
    { timeout: 20000 },
  );
  assert.ok((await gap()) > 200, "a new turn must not drag the reader back down");
  assert.equal(await page.locator("#jump").isVisible(), true, "and the way back stays offered");

  await page.click("#jump");
  await page.waitForFunction(
    () => {
      const box = /** @type {HTMLElement} */ (document.getElementById("transcript"));
      return box.scrollHeight - box.scrollTop - box.clientHeight < 5;
    },
    undefined,
    { timeout: 3000 },
  );
  assert.equal(await page.locator("#jump").isVisible(), false);

  await runTurn("make it tall");
  const followed = await page
    .waitForFunction(
      () => {
        const box = /** @type {HTMLElement} */ (document.getElementById("transcript"));
        return box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      },
      null,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  assert.equal(followed, true, "the arrow re-armed the follow");
});

test("opening a chat lands on its newest line", { skip: blocked }, async () => {
  const rows = await page
    .locator("#tab-list .tab")
    .evaluateAll((/** @type {HTMLElement[]} */ list) => list.map((row) => String(row.dataset.tab)));
  const elsewhere = rows.find((/** @type {string} */ id) => id !== longTab);
  assert.ok(elsewhere, "a second chat is open");

  await switchTo(elsewhere);
  await page.evaluate(() => {
    const box = /** @type {HTMLElement} */ (document.getElementById("transcript"));
    box.scrollTop = 0;
  });

  await switchTo(longTab);
  await page.waitForFunction(
    () => {
      const box = /** @type {HTMLElement} */ (document.getElementById("transcript"));
      return box.scrollHeight - box.clientHeight > 150 && box.scrollHeight - box.scrollTop - box.clientHeight < 5;
    },
    undefined,
    { timeout: 30000 },
  );
});

test("the footer ring says how full the window is", { skip: blocked }, async () => {
  const ring = page.locator("#context");
  await ring.waitFor({ state: "visible" });
  assert.equal(await ring.locator("#context-pct").innerText(), "31%");
  assert.match(String(await ring.locator("#context-ring").getAttribute("style")), /--used: 0\.305/);
  assert.match(await ring.getAttribute("title"), /61k \/ 200k/);
});

test("only the transcript scrolls", { skip: blocked }, async () => {
  const shape = await page.evaluate(() => {
    const transcript = document.getElementById("transcript");
    const composer = document.querySelector(".composer");
    return {
      overflow: transcript ? getComputedStyle(transcript).overflowY : "",
      composerInView: composer ? composer.getBoundingClientRect().bottom <= window.innerHeight : false,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
    };
  });
  assert.ok(["auto", "scroll"].includes(shape.overflow), "the transcript is the scroll container");
  assert.equal(shape.composerInView, true, "the composer stays on screen");
  assert.equal(shape.pageScrolls, false, "the page itself does not scroll");
});

test("a streaming answer leaves the chat list where it is", { skip: blocked }, async () => {
  await openProjectChat(gitProject);
  const first = await activeTab();
  await openFreshChat();
  const second = await activeTab();
  await switchTo(first);
  await idle();

  await page.fill("#input", "a steady stream");
  await page.click("#send");
  await page.waitForFunction(() => !!document.querySelector("#tab-list .tab.active .spinner"));
  await page.waitForFunction(() => (document.querySelector("#transcript .block.text")?.textContent ?? "").length > 30);

  const churn = await page.evaluate(async () => {
    let records = 0;
    const watcher = new MutationObserver((list) => {
      records += list.length;
    });
    watcher.observe(/** @type {HTMLElement} */ (document.getElementById("tab-list")), { childList: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    watcher.disconnect();
    return records;
  });
  assert.ok(churn <= 4, `the chat list was rebuilt ${churn} times while one answer streamed`);

  // A press is not a point in time: the row has to still be there when the
  // finger comes back up.
  const box = await page.locator(`#tab-list .tab[data-tab="${second}"]`).boundingBox();
  assert.ok(box, "the other chat is in the list");
  await page.mouse.move(box.x + 24, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.mouse.up();

  await present(`#tab-list .tab[data-tab="${second}"]`);
  await page.waitForFunction(
    /** @param {string} want */
    (want) => document.querySelector("#tab-list .tab.active")?.getAttribute("data-tab") === want,
    second,
    { timeout: 10000 },
  );
});

test("a turn that stops on a thought says there is nothing after it", { skip: blocked }, async () => {
  await idle();
  await page.fill("#input", "be dumbstruck this time");
  await page.click("#send");

  const thought = page.locator("#transcript .block.thinking").last();
  await thought.locator(".state", { hasText: "nothing after" }).waitFor({ state: "visible", timeout: 30000 });

  assert.equal(
    await thought.locator("details").evaluate((/** @type {any} */ fold) => fold.open),
    true,
    "the only thing the turn left behind is not folded away",
  );
  assert.match(await thought.locator(".fold-body").innerText(), /never says it/);
});

test("older messages are painted on upward scroll without moving the reading position", { skip: blocked }, async () => {
  const messages = Array.from({ length: 180 }, (_, index) => ({
    role: "user",
    content: [{ type: "text", text: `history message ${index}` }],
    timestamp: index,
  }));
  await page.route("**/api/events?*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `retry: 60000\ndata: ${JSON.stringify({ type: "response", command: "get_messages", data: { messages } })}\n\n`,
    }),
  );
  try {
    await openFreshChat();
    await page.waitForFunction(() => document.querySelectorAll("#transcript .block").length === 60);
    assert.match(await page.locator("#transcript .block").first().textContent(), /history message 120/);
    assert.match(await page.locator("#transcript .block").last().textContent(), /history message 179/);
    const before = await page
      .locator("#transcript .block")
      .first()
      .evaluate((node) => {
        const box = document.getElementById("transcript");
        if (box) box.scrollTop = 0;
        return { text: node.textContent, top: node.getBoundingClientRect().top };
      });
    await page.waitForFunction(() => document.querySelectorAll("#transcript .block").length === 120);
    const after = await page
      .locator("#transcript .block")
      .nth(60)
      .evaluate((node) => ({
        text: node.textContent,
        top: node.getBoundingClientRect().top,
      }));
    assert.equal(after.text, before.text);
    assert.ok(Math.abs(after.top - before.top) < 2);
    assert.match(await page.locator("#transcript .block").first().textContent(), /history message 60/);
    await page.locator("#transcript").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.waitForFunction(() => document.querySelectorAll("#transcript .block").length === 180);
    assert.match(await page.locator("#transcript .block").first().textContent(), /history message 0/);
  } finally {
    await page.unroute("**/api/events?*");
  }
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
