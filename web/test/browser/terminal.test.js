// @ts-check

/** Browser tests about terminal. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  blocked,
  chatId,
  clipboardHolds,
  closeTerminalView,
  crashes,
  gitProject,
  hold,
  openProjectChat,
  openTerminalTab,
  page,
  start,
  stop,
  toastSays,
} from "./harness.mjs";

async function shellSays(/** @type {string} */ command, /** @type {string} */ want) {
  await page.locator("#terminal .term-screen:visible").first().click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    /** @param {string} needle */
    (needle) =>
      [...document.querySelectorAll("#terminal .term-row")].some(
        (row) => row.offsetParent !== null && (row.textContent ?? "").includes(needle),
      ),
    want,
    { timeout: 15000 },
  );
}

async function openShell() {
  await openProjectChat(gitProject);
  await openTerminalTab();
  await page.waitForFunction(() => document.getElementById("terminal")?.hidden === false, null, { timeout: 5000 });
}

before(start);
after(stop);

test("a terminal opens in the project and answers what you type", { skip: blocked }, async () => {
  await openProjectChat(gitProject);
  const rows = await page.evaluate(() => document.querySelectorAll("#tab-list .tab").length);

  // Something in the chat to come back to afterwards.
  await page.fill("#input", "what folder is this");
  await page.click("#send");
  await page.waitForSelector("#stream .block", { timeout: 10000 });

  await openTerminalTab();

  await page.waitForFunction(() => document.getElementById("terminal")?.hidden === false, null, { timeout: 5000 });

  // A terminal is a tab of the chat it was opened from, so it turns up in the
  // strip above it and never as a row of its own in the sidebar.
  assert.equal(await page.evaluate(() => document.querySelectorAll("#view-tabs .view").length), 2);
  assert.equal(await page.evaluate(() => document.querySelectorAll("#tab-list .tab").length), rows);

  // The server opened the shell in the folder of the chat in view, and filed it
  // under that chat. Where the shell goes after that is its own startup files'
  // doing, and an interactive bash is allowed to move on its own here exactly
  // as it does in any other terminal on the machine.
  const mine = await chatId();
  const opened = await page.evaluate(async () => (await (await fetch("/api/pty")).json()).shells);
  assert.ok(
    opened.some((/** @type {{cwd: string, tab: string}} */ shell) => shell.cwd === gitProject && shell.tab === mine),
    "the terminal belongs to the chat it was opened from",
  );

  // Something only a shell can answer, typed the way a person types.
  await page.locator(".term-screen").first().click();
  await page.keyboard.type("printf pi%sui7\n");

  await page.waitForFunction(
    /** @param {string} want */
    (want) =>
      [...document.querySelectorAll(".term-screen")]
        .map((n) => n.textContent)
        .join("\n")
        .includes(want),
    "piui7",
    { timeout: 15000 },
  );

  assert.equal(await page.evaluate(() => document.getElementById("meter-bar")?.hidden), true);
});

test("the chat comes back whole when the terminal view is closed", { skip: blocked }, async () => {
  await closeTerminalView();
  await page.waitForFunction(() => document.getElementById("terminal")?.hidden === true, null, { timeout: 5000 });

  assert.equal(await page.evaluate(() => document.querySelectorAll("#view-tabs .view").length), 1);
  assert.equal(await page.evaluate(() => document.getElementById("composer")?.hidden), false);
  assert.equal((await page.evaluate(() => document.getElementById("stream")?.innerText ?? "")).length > 0, true);
});

test("closing a terminal view ends the shell on the server", { skip: blocked }, async () => {
  await openTerminalTab();
  await page.waitForFunction(() => document.getElementById("terminal")?.hidden === false, null, { timeout: 5000 });

  const mine = await chatId();
  const id = await page.evaluate(
    /** @param {string} chat */
    async (chat) => {
      /** @type {{shells: {id: string, tab: string}[]}} */
      const list = await (await fetch("/api/pty")).json();
      return list.shells.find((shell) => shell.tab === chat)?.id ?? "";
    },
    mine,
  );
  assert.ok(id.startsWith("s"), "the shell is numbered like a shell");

  await closeTerminalView();

  await page.waitForFunction(
    /** @param {string} want */
    async (want) => {
      /** @type {{shells: {id: string}[]}} */
      const list = await (await fetch("/api/pty")).json();
      return !list.shells.some((shell) => shell.id === want);
    },
    id,
    { timeout: 5000 },
  );
});

test("the terminal window stops at the edge of its panel", { skip: blocked }, async () => {
  await openTerminalTab();
  await page.waitForFunction(() => document.getElementById("terminal")?.hidden === false, null, { timeout: 5000 });

  /** What the panel measures, and how much of it the text reaches past. */
  const measure = () =>
    page.evaluate(() => {
      const scroll = /** @type {HTMLElement} */ (document.querySelector("#terminal .term-scroll"));
      const inset = window.getComputedStyle(scroll);
      const boxes = [.../** @type {NodeListOf<HTMLElement>} */ (scroll.querySelectorAll(".term-row"))].map((row) => ({
        box: row.getBoundingClientRect(),
        letters: (row.textContent ?? "").replace(/\s+$/, "").length,
      }));
      return {
        wide: scroll.clientWidth - parseFloat(inset.paddingLeft) - parseFloat(inset.paddingRight),
        tall: scroll.clientHeight - parseFloat(inset.paddingTop) - parseFloat(inset.paddingBottom),
        sideways: scroll.scrollWidth - scroll.clientWidth,
        updown: scroll.scrollHeight - scroll.clientHeight,
        rows: boxes.length,
        tallest: Math.max(0, ...boxes.map((one) => one.box.height)),
        widest: Math.max(0, ...boxes.map((one) => one.box.width)),
        fullest: Math.max(0, ...boxes.map((one) => one.letters)),
      };
    });

  const empty = await measure();
  assert.ok(empty.rows >= 3, `the shell was given a window to fill: ${empty.rows} rows`);
  assert.ok(empty.rows * empty.tallest <= empty.tall, `${empty.rows} rows of ${empty.tallest} in ${empty.tall}`);
  assert.ok(empty.updown <= 1, `nothing to scroll up and down yet: ${empty.updown}`);

  // A full-width program is where an over-sized window shows: btop, vim and friends draw every
  // column to the last one, so one column too many is a line past the edge and a second scrollbar.
  await page.locator("#terminal .term-screen").first().click();
  await page.keyboard.type("printf '%.0s=' {1..600}; printf piui9\n");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#terminal .term-row")].some((row) => (row.textContent ?? "").includes("piui9")),
    undefined,
    { timeout: 15000 },
  );

  const full = await measure();
  assert.ok(full.fullest > 40, `the screen is drawn to its last column: ${full.fullest}`);
  assert.ok(full.widest <= full.wide, `no line reaches past the panel: ${full.widest} of ${full.wide}`);
  assert.equal(full.sideways, 0, "and nothing to scroll sideways to");

  await closeTerminalView();
});

test("a character the terminal font has never seen still takes one cell", { skip: blocked }, async () => {
  await openTerminalTab();
  await page.waitForFunction(() => document.getElementById("terminal")?.hidden === false, null, { timeout: 5000 });

  // btop draws its graphs in braille, and no monospace font on this machine has those glyphs, so
  // they come from a fallback face with a width of their own. Left alone they push the rest of the
  // row out of step, which is what made btop's boxes lean.
  await page.locator("#terminal .term-screen").first().click();
  await page.keyboard.type("printf '%s\\n' '│⣿⣿⣿⣿│' '│AAAA│'; printf '⣿%.0s' {1..120}; printf '\\npiui8\\n'");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#terminal .term-row")].some((row) => (row.textContent ?? "").includes("piui8")),
    undefined,
    { timeout: 15000 },
  );

  const widths = await page.evaluate(() => {
    /** @param {string} needle */
    const room = (needle) => {
      const row = [...document.querySelectorAll("#terminal .term-row")].find((one) =>
        (one.textContent ?? "").includes(needle),
      );
      if (!row) return -1;
      const range = document.createRange();
      range.selectNodeContents(row);
      return range.getBoundingClientRect().width;
    };
    const scroll = /** @type {HTMLElement} */ (document.querySelector("#terminal .term-scroll"));
    return { braille: room("⣿⣿⣿⣿"), letters: room("│AAAA│"), sideways: scroll.scrollWidth - scroll.clientWidth };
  });

  assert.ok(widths.braille > 0 && widths.letters > 0, "both lines are on the screen");
  assert.ok(
    Math.abs(widths.braille - widths.letters) < 0.5,
    `braille takes the same room as letters: ${widths.braille} against ${widths.letters}`,
  );
  assert.equal(widths.sideways, 0, "and a screenful of it does not reach past the panel");

  await closeTerminalView();
});

test("a drag over the terminal copies what it covered", { skip: blocked }, async () => {
  await openShell();
  await shellSays("printf 'piui-copy-target\\n'", "piui-copy-target");

  const row = page.locator("#terminal .term-row:visible", { hasText: "piui-copy-target" }).last();
  const box = await row.boundingBox();
  assert.ok(box, "the line the shell printed is on the screen");

  await page.evaluate(() => {
    const toast = /** @type {HTMLElement | null} */ (document.getElementById("toast"));
    if (toast) toast.textContent = "";
  });
  await page.mouse.move(box.x + 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await clipboardHolds("piui-copy-target");
  await toastSays(/Copied/);

  await closeTerminalView();
});

test("what the clipboard holds reaches the shell without a key going missing", { skip: blocked }, async () => {
  await openShell();

  await hold("pasted by piui");
  await page.locator("#terminal .term-screen:visible").first().click();
  await page.keyboard.press("Control+v");

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#terminal .term-row")].some(
        (row) => row.offsetParent !== null && (row.textContent ?? "").includes("pasted by piui"),
      ),
    undefined,
    { timeout: 15000 },
  );

  await closeTerminalView();
});

test("a program in the terminal can put the clipboard there itself", { skip: blocked }, async () => {
  await openShell();

  const coded = Buffer.from("yanked in the shell").toString("base64");
  await hold("");
  await shellSays(`printf '\\033]52;c;${coded}\\a'; printf yanked-done\\n`, "yanked-done");

  await clipboardHolds("yanked in the shell");
  await toastSays(/Copied/);

  await closeTerminalView();
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
