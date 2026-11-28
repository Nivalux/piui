// @ts-check

/** Browser tests about sidebar. */

import { after, before, test } from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { relativeTime } from "../../format.js";
import {
  activeTab,
  base,
  blocked,
  crashes,
  goneProject,
  idle,
  menuHangsUnder,
  onePixelPng,
  openFreshChat,
  page,
  scratchDir,
  sidebarIds,
  start,
  stop,
  switchTo,
  toastSays,
} from "./harness.mjs";

before(start);
after(stop);
test("the session list is ordered by its newest line", { skip: blocked }, async () => {
  await page.waitForSelector("#session-list .session");
  const titles = await page.locator("#session-list .session .session-title").allInnerTexts();
  assert.equal(titles[0], "explain the pi wiring", "the session with the newest last line comes first");
  assert.equal(titles.length, 5);
});

test("a fork says it is one, and says which chat it came from", { skip: blocked }, async () => {
  await page.waitForSelector("#session-list .session");
  /** @type {{title: string, glyph: number, meta: string, tip: string}[]} */
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#session-list .session")].map((row) => ({
      title: row.querySelector(".session-title")?.textContent ?? "",
      glyph: row.querySelectorAll(".fork-mark svg").length,
      meta: row.querySelector(".session-meta")?.textContent ?? "",
      tip: row.getAttribute("title") ?? "",
    })),
  );

  const forks = rows.filter((row) => row.glyph > 0);
  assert.deepEqual(
    forks.map((row) => row.title),
    ["#2 explain the pi wiring", "#1 explain the pi wiring"],
    "the two forks of one chat are numbered, newest first in the list",
  );
  assert.ok(
    forks.every((row) => row.meta.includes("· fork of explain the pi wiring")),
    "the line under a fork names the chat it was copied from",
  );
  const age = relativeTime(Date.parse("2026-11-22T09:00:00.000Z"), await page.evaluate(() => Date.now()));
  assert.ok(forks[0].meta.startsWith(`${age} · 2 msgs`), "and still leaves time and count readable");
  assert.ok(forks[0].tip.includes("explain the pi wiring"), "hovering says it too");

  const plain = rows.find((row) => row.title === "nothing else at all");
  assert.equal(plain?.glyph, 0, "a chat nobody forked wears nothing");
  assert.ok(plain !== undefined && !plain.meta.includes("fork of"), "and its line stays time and count");
});

test("typing in the sidebar filters it the way fzf does", { skip: blocked }, async () => {
  await page.evaluate(() => /** @type {any} */ (document.activeElement)?.blur());
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "filter", "/ focuses the filter");

  await page.fill("#filter", "xplw");
  const titles = await page.locator("#session-list .session .session-title").allInnerTexts();
  assert.equal(titles.length, 3, "a fork is found by the line it copied");
  assert.ok(
    titles.every((text) => text.endsWith("explain the pi wiring")),
    "letters in order, gaps allowed, one chat and its two forks",
  );
  assert.ok((await page.locator("#session-list .session-title mark").count()) > 0, "the matched letters are marked");

  await page.fill("#filter", "qqqq");
  assert.equal(await page.locator("#session-list .session").count(), 0);

  await page.keyboard.press("Escape");
  assert.equal(await page.inputValue("#filter"), "");
  assert.equal(await page.locator("#session-list .session").count(), 5);
});

test("the project picker completes a path and opens a chat in it", { skip: blocked }, async () => {
  await page.click("#new-project");
  await page.waitForSelector("#dir-field");

  const opened = await page.inputValue("#dir-field");
  assert.ok(opened.endsWith("/"), "a folder is offered as a folder");

  await page.waitForSelector("#dir-list .dir-row");
  /** @type {string[]} */ const names = (await page.locator("#dir-list .dir-row").allInnerTexts()).map(
    (/** @type {string} */ text) => text.replace("\u25b8", "").trim(),
  );
  assert.ok(names.includes("src"), "the folders under it are listed");
  assert.ok(!names.some((name) => name.startsWith(".")), "hidden folders stay out");

  const tabs = await page.locator("#tab-list .tab").count();

  await page.fill("#dir-field", `${opened}we`);
  await page.waitForFunction(() => document.querySelectorAll("#dir-list .dir-row").length === 1);
  const narrowed = await page.evaluate(() => document.querySelector("#dir-list .dir-row")?.getAttribute("data-path"));
  assert.equal(narrowed, `${opened.slice(0, -1)}/web`, "typing narrows the list");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const field = /** @type {HTMLInputElement | null} */ (document.getElementById("dir-field"));
    return String(field?.value ?? "").endsWith("/web/");
  });
  await page.waitForFunction(() => {
    const paths = [...document.querySelectorAll("#dir-list .dir-row")].map((row) =>
      String(row.getAttribute("data-path") ?? ""),
    );
    return paths.some((one) => one.endsWith("/web/test"));
  });

  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (/** @type {number} */ count) => document.querySelectorAll("#tab-list .tab").length > count,
    tabs,
    { timeout: 30000 },
  );
  await page.waitForFunction(() => document.getElementById("dir-modal")?.hidden === true);
  assert.match(String(await page.textContent("#tab-cwd")), /\/web$/, "the chat runs in the chosen folder");
});

test("escape closes the picker without opening anything", { skip: blocked }, async () => {
  await idle();
  const tabs = await page.locator("#tab-list .tab").count();
  await page.click("#new-project");
  await page.waitForSelector("#dir-field");
  await page.focus("#dir-field");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("dir-modal")?.hidden === true);
  assert.equal(await page.locator("#tab-list .tab").count(), tabs);
});

test("a chat taken from the session list goes back to its own project", { skip: blocked }, async () => {
  await openFreshChat();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#session-list .session-title")].some(
        (node) => node.textContent === "explain the pi wiring",
      ),
    undefined,
    { timeout: 30000 },
  );

  await page.locator("#session-list .session", { hasText: "explain the pi wiring" }).first().click();
  await page.waitForFunction(
    () => String(document.getElementById("tab-cwd")?.textContent ?? "").includes("wired-project"),
    undefined,
    { timeout: 20000 },
  );

  const row = await page.locator("#tab-list .tab.active").innerText();
  assert.match(row, /wired-project/, "the row names the project the session came from");
  assert.ok(!row.includes("scratch"), "not the throwaway folder the chat happens to run in");
});

test("opening a settled chat is not activity, so the list keeps its order", async () => {
  const first = await openFreshChat();
  const second = await openFreshChat();
  await page.waitForSelector(`#tab-list .tab[data-tab="${first}"]`);
  await page.waitForSelector(`#tab-list .tab[data-tab="${second}"]`);

  // Other tests leave their chats open, so only the pair this test made is compared.
  const pair = async () =>
    (await sidebarIds()).filter((/** @type {string | undefined} */ id) => id === first || id === second);

  const before = await pair();
  assert.deepEqual(before, [second, first], "the newer chat sits on top");

  for (let round = 0; round < 3; round += 1) {
    await switchTo(first);
    await switchTo(second);
  }

  assert.deepEqual(await pair(), before, "clicking back and forth moved nothing");
});

test("a picture dragged into the composer shows the picture, not just a label", async () => {
  await openFreshChat();

  await page.evaluate(
    /** @param {string} data */
    async (data) => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
      const file = new File([blob], "screenshot.png", { type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const box = document.getElementById("composer");
      if (!box) return;
      box.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
      box.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    },
    onePixelPng,
  );

  const thumb = page.locator("#attachments .attachment img");
  await thumb.waitFor({ state: "visible", timeout: 10000 });
  const box = await thumb.boundingBox();
  assert.ok(box, "the chip has a box");
  assert.ok(box.width >= 40 && box.height >= 30, `the chip holds a ${box.width}x${box.height} picture`);
  const decoded = await page.evaluate(() => {
    const img = /** @type {HTMLImageElement | null} */ (document.querySelector("#attachments .attachment img"));
    return (img?.naturalWidth ?? 0) > 0;
  });
  assert.ok(decoded, "the dropped bytes decoded");

  await page.locator("#attachments .attachment button").click();
  assert.equal(await page.locator("#attachments .attachment").count(), 0, "× drops it again");
});

test("a drag that carried no bytes says so instead of showing a dead chip", async () => {
  await openFreshChat();

  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([], "screenshot.png", { type: "image/png" }));
    const box = document.getElementById("composer");
    if (!box) return;
    box.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
    box.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  });

  await page.waitForSelector("#attachments .attach-note", { state: "visible" });
  assert.match(
    String(await page.locator("#attachments .attach-note").innerText()),
    /without its bytes/,
    "the reader is told why nothing appeared",
  );
  assert.equal(await page.locator("#attachments .attachment").count(), 0, "an empty file attaches nothing");
});

test("a row's actions sit behind a ⋯, and right-click is inert", async () => {
  await openFreshChat();
  const chat = await activeTab();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const row = () => page.locator(`#tab-list .tab[data-tab="${chat}"]`);

  assert.equal(await row().locator(".row-menu").count(), 1);

  await row().locator(".row-menu").click();
  await page.waitForSelector(".row-actions", { state: "visible" });
  await menuHangsUnder(row());
  assert.deepEqual(await page.locator(".row-action").allInnerTexts(), ["Copy path", "Archive into sessions"]);
  assert.equal(await activeTab(), chat, "opening the menu does not move anywhere");

  await page.locator(".row-action", { hasText: "Copy path" }).click();
  await toastSays(/copied \//);
  assert.equal(await page.locator(".row-actions").count(), 0, "a choice closes the menu");
  assert.equal(await activeTab(), chat, "copying touches nothing but the clipboard");

  await row().click({ button: "right" });
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".row-actions").count(), 0, "right-click opens nothing");
  assert.equal(await activeTab(), chat, "right-click no longer closes a chat");

  await row().locator(".row-menu").click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".row-actions").count(), 0, "Escape closes it again");

  await row().locator(".row-menu").click();
  await page.locator(".row-action", { hasText: "Archive" }).click();
  await page.waitForFunction(
    (/** @type {string} */ id) => document.querySelector(`#tab-list .tab[data-tab="${id}"]`) === null,
    chat,
    { timeout: 10000 },
  );
});

test("a session row offers its folder and its session file without opening the chat", async () => {
  const before = await activeTab();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const row = page.locator(".session").first();

  await row.locator(".row-menu").click();
  await page.waitForSelector(".row-actions", { state: "visible" });
  await menuHangsUnder(row);
  assert.deepEqual(await page.locator(".row-action").allInnerTexts(), ["Copy path", "Copy session path"]);
  assert.equal(await activeTab(), before, "the chat behind it stayed put");

  await page.locator(".row-action", { hasText: "Copy path" }).click();
  await toastSays(/copied \//);

  await row.locator(".row-menu").click();
  await page.locator(".row-action", { hasText: "Copy session path" }).click();
  await toastSays(/copied .*\.jsonl/);
  const held = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(held, /\.jsonl$/, "the clipboard holds the session file itself");
  assert.equal(await activeTab(), before, "copying the file left the chat alone");
});

test("an open chat hands out its own session file as well", { skip: blocked }, async () => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await page.locator("#session-list .session").first().click();
  const chat = await activeTab();
  const row = page.locator(`#tab-list .tab[data-tab="${chat}"]`);

  await row.locator(".row-menu").click();
  await page.waitForSelector(".row-actions", { state: "visible" });
  await page.locator(".row-action", { hasText: "Copy session path" }).click();
  await toastSays(/copied .*\.jsonl/);
  const held = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(held, /\.jsonl$/, "the clipboard holds the file of the chat that is open");
});

test("a second ⋯ takes the first menu down instead of stacking on it", { skip: blocked }, async () => {
  await openFreshChat();
  const first = await activeTab();
  await openFreshChat();
  const second = await activeTab();
  const row = (/** @type {string} */ id) => page.locator(`#tab-list .tab[data-tab="${id}"]`);

  await row(first).locator(".row-menu").click();
  await page.waitForSelector(".row-actions", { state: "visible" });

  await row(second).locator(".row-menu").click();
  await page.waitForSelector(".row-actions", { state: "visible" });
  assert.equal(await page.locator(".row-actions").count(), 1, "one menu, not two over each other");
  await menuHangsUnder(row(second));

  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".row-actions").count(), 0);
});

test("closing a chat that is still working asks first", { skip: blocked }, async () => {
  await openFreshChat();
  const chat = await activeTab();

  await page.fill("#input", "the long one, please");
  await page.click("#send");
  await page.waitForFunction(() => document.getElementById("busy")?.hidden === false, null, { timeout: 15000 });

  await page.click("#kill");
  await page.waitForSelector("#ask-modal", { state: "visible" });
  assert.match(await page.locator("#ask-modal .card-title").innerText(), /stop this chat/i);

  await page.locator("#ask-modal button", { hasText: "Cancel" }).click();
  await page.waitForSelector("#ask-modal", { state: "hidden" });
  assert.equal(await activeTab(), chat, "no means the run goes on");

  await page.click("#kill");
  await page.waitForSelector("#ask-modal", { state: "visible" });
  await page.locator("#ask-modal button", { hasText: "Stop and close" }).click();
  await page.waitForFunction(
    (/** @type {string} */ id) => document.querySelector(`#tab-list .tab[data-tab="${id}"]`) === null,
    chat,
    { timeout: 15000 },
  );
});

test("a chat whose folder is gone is read from a copy, not by putting the folder back", { skip: blocked }, async () => {
  assert.ok(!fs.existsSync(goneProject), "its folder went away before the server started");

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#session-list .session-title")].some(
        (node) => node.textContent === "a chat whose home is gone",
      ),
    undefined,
    { timeout: 30000 },
  );
  await page.locator("#session-list .session", { hasText: "a chat whose home is gone" }).first().click();

  await page.waitForSelector(".chat-ended .ended-title", { timeout: 30000 });
  const note = await page.locator(".chat-ended").innerText();
  assert.match(note, /folder this chat was written in is gone/);
  assert.match(note, /gone-project/, "the notice names the folder that is missing");

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#transcript .block.user")].some((node) =>
        String(node.textContent).includes("a chat whose home is gone"),
      ),
    undefined,
    { timeout: 30000 },
  );

  const where = String(await page.locator("#tab-cwd").textContent());
  assert.ok(!where.includes(goneProject), "nothing runs in the folder that is gone");
  assert.ok(!fs.existsSync(goneProject), "reading a chat never makes its folder again");

  await page.locator(".chat-ended button", { hasText: "create the folder" }).click();
  await page.waitForFunction(
    () => String(document.getElementById("tab-cwd")?.textContent ?? "").includes("gone-project"),
    undefined,
    { timeout: 30000 },
  );

  assert.ok(fs.existsSync(goneProject), "the folder came back because a person asked for it");
  assert.ok(!(await page.locator(".chat-ended").isVisible()), "and the notice has nothing left to say");
});

test("a working chat says how long; the spinner says the rest", { skip: blocked }, async () => {
  await openFreshChat();
  await page.fill("#input", "and now the long one");
  await page.click("#send");

  const row = page.locator("#tab-list .tab.active");
  await row.locator(".spinner").waitFor({ state: "visible", timeout: 10000 });
  const status = (await row.locator(".tab-status").innerText()).trim();
  assert.doesNotMatch(status, /working/, "the spinner is that word");
  assert.match(status, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\d+[smhd]$/, `only the indicator and time: ${status}`);
  await idle();
});

test("the broom closes every chat and clears the folders piui made for them", { skip: blocked }, async () => {
  await openFreshChat();
  await openFreshChat();
  await page.waitForFunction(() => document.querySelectorAll("#tab-list .tab").length >= 2, null, { timeout: 15000 });
  const minted = fs.readdirSync(scratchDir);
  assert.ok(minted.length >= 2, `each chat was given a folder, found ${minted.length}`);

  await page.click("#sweep");
  await page.waitForSelector("#ask-modal", { state: "visible" });
  assert.match(await page.locator("#ask-modal .card-title").innerText(), /clean up/i);
  await page.locator("#ask-modal button", { hasText: "Cancel" }).click();
  await page.waitForSelector("#ask-modal", { state: "hidden" });
  assert.deepEqual(fs.readdirSync(scratchDir), minted, "no means the folders stay where they are");

  await page.click("#sweep");
  await page.waitForSelector("#ask-modal", { state: "visible" });
  await page.locator("#ask-modal button", { hasText: "Close and delete" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#tab-list .tab").length === 0, null, { timeout: 15000 });
  await toastSays(/cleared/);
  assert.deepEqual(fs.readdirSync(scratchDir), [], "the folders piui minted are gone with what was in them");
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
