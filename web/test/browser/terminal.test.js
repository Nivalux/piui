// @ts-check

/** Browser tests about terminal. */

import { after, before, beforeEach, test } from "node:test";
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

/** The box of a visible line carrying `needle`, measured in one task so a repaint cannot slip between. */
async function lineBox(needle) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const seen = await page.evaluate((want) => {
      const rows = [...document.querySelectorAll("#terminal .term-row")].filter(
        (row) => row.offsetParent !== null && (row.textContent ?? "").includes(want),
      );
      const last = /** @type {HTMLElement | undefined} */ (rows.at(-1));
      if (!last) return null;
      const rect = last.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, needle);
    if (seen) return seen;
    if (Date.now() > deadline) return null;
    await new Promise((done) => setTimeout(done, 50));
  }
}

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
    { timeout: 25000 },
  );
}

/**
 * Closes a tty view a failed test left behind, so the next one does not inherit its shell. The
 * strip is being rebuilt while a turn winds down, so a click that lands on a button on its way out
 * is tried again rather than waited on.
 */
async function closeAnyTerminal() {
  const close = page.locator('#view-tabs .view:has(.view-tab:has-text("tty")) .view-close');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await close.count()) === 0) return;
    await close
      .first()
      .click({ timeout: 1500 })
      .catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.waitForFunction(() => document.getElementById("terminal")?.hidden === true, null, { timeout: 5000 });
}

/**
 * Opens a terminal and waits until the shell behind it takes what is typed. The view is on screen
 * a beat before the pty is attached, and keys typed in that beat are gone.
 */
async function openTerminal() {
  await openTerminalTab();
  await page.waitForFunction(() => document.getElementById("terminal")?.hidden === false, null, { timeout: 5000 });
  const screen = page.locator("#terminal .term-screen:visible").first();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (let try_ = 0; try_ < 4; try_ += 1) {
      await screen.click();
      if (await page.evaluate(() => document.getElementById("terminal")?.contains(document.activeElement) === true)) {
        break;
      }
      await page.waitForTimeout(150);
    }
    await page.keyboard.type("printf 'piui-ready\\n'");
    await page.keyboard.press("Enter");
    const answered = await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll("#terminal .term-row")].some(
            (/** @type {HTMLElement} */ row) => row.textContent?.trim() === "piui-ready",
          ),
        null,
        { timeout: 9000 },
      )
      .then(() => true)
      .catch(() => false);
    if (answered) return;
  }
  throw new Error("the shell behind this terminal never answered the probe");
}

/** Starts a chat of our own, with a shell in it that has been shown to answer. */
async function openShell() {
  await openProjectChat(gitProject);
  await closeAnyTerminal();
  await openTerminal();
}

/** Runs a command until the shell has pushed lines past the top of the window. */
async function shellScrollsBack(/** @type {string} */ command) {
  await page.locator("#terminal .term-screen:visible").first().click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#terminal .term-row.past").length > 25, null, {
    timeout: 20000,
  });
}

before(start);
after(stop);

beforeEach(async () => {
  if (blocked) return;
  await closeAnyTerminal();
});

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
    { timeout: 25000 },
  );

  assert.equal(await page.evaluate(() => document.getElementById("meter-bar")?.hidden), true);
});

test("the chat comes back whole when the terminal view is closed", { skip: blocked }, async () => {
  await openTerminal();

  await closeTerminalView();
  await page.waitForFunction(() => document.getElementById("terminal")?.hidden === true, null, { timeout: 5000 });

  assert.equal(await page.evaluate(() => document.querySelectorAll("#view-tabs .view").length), 1);
  assert.equal(await page.evaluate(() => document.getElementById("composer")?.hidden), false);
  await page.waitForSelector("#stream .block:visible", { timeout: 5000 });
  assert.equal((await page.evaluate(() => document.getElementById("stream")?.innerText ?? "")).length > 0, true);
});

test("closing a terminal view ends the shell on the server", { skip: blocked }, async () => {
  await openTerminal();

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
  await openTerminal();

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
    { timeout: 25000 },
  );

  const full = await measure();
  assert.ok(full.fullest > 40, `the screen is drawn to its last column: ${full.fullest}`);
  assert.ok(full.widest <= full.wide, `no line reaches past the panel: ${full.widest} of ${full.wide}`);
  assert.equal(full.sideways, 0, "and nothing to scroll sideways to");

  await closeTerminalView();
});

test("a character the terminal font has never seen still takes one cell", { skip: blocked }, async () => {
  await openTerminal();

  // btop draws its graphs in braille, and no monospace font on this machine has those glyphs, so
  // they come from a fallback face with a width of their own. Left alone they push the rest of the
  // row out of step, which is what made btop's boxes lean.
  await page.locator("#terminal .term-screen").first().click();
  await page.keyboard.type("printf '%s\\n' '│⣿⣿⣿⣿│' '│AAAA│'; printf '⣿%.0s' {1..120}; printf '\\npiui8\\n'");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#terminal .term-row")].some((row) => (row.textContent ?? "").includes("piui8")),
    undefined,
    { timeout: 25000 },
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

  const box = await lineBox("piui-copy-target");
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
    { timeout: 25000 },
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

test("the caret stands on the line the shell is writing", { skip: blocked }, async () => {
  await openShell();
  await shellScrollsBack("yes piui6 | head -160");

  const standing = await page.evaluate(() => {
    const scroll = /** @type {HTMLElement} */ (document.querySelector("#terminal .term-scroll"));
    const caret = /** @type {HTMLElement} */ (document.querySelector("#terminal .term-caret"));
    const rows = [...document.querySelectorAll("#terminal .term-row")];
    const box = caret.getBoundingClientRect();
    const edge = scroll.getBoundingClientRect();
    const bottom = /** @type {HTMLElement} */ (rows.at(-1));
    return {
      past: rows.filter((row) => row.classList.contains("past")).length,
      inView: box.top >= edge.top && box.bottom <= edge.bottom + 1,
      onBottom: Math.abs(box.top - bottom.getBoundingClientRect().top) < 1,
    };
  });

  assert.ok(standing.past > 25, `the shell has scrolled back: ${standing.past} lines`);
  assert.equal(standing.inView, true, "the caret stands where you are looking");
  assert.equal(standing.onBottom, true, "the caret stands on the line the shell is writing");

  await closeTerminalView();
});

test("a line that scrolled past keeps the colour it was written in", { skip: blocked }, async () => {
  await openShell();
  await shellScrollsBack("for i in $(seq 1 160); do printf '\\033[1;32m\\x67reen\\033[0m\\n'; done");

  const looks = await page.evaluate(() => {
    const withText = (/** @type {string} */ selector) =>
      [...document.querySelectorAll(selector)].filter((row) => (row.textContent ?? "").includes("green"));
    const look = (/** @type {Element} */ row) => {
      const span = /** @type {HTMLElement} */ (row.querySelector("span"));
      const ink = getComputedStyle(span);
      return `${ink.color} ${ink.fontWeight} ${getComputedStyle(row).opacity}`;
    };
    const past = withText("#terminal .term-row.past");
    const live = withText("#terminal .term-row:not(.past)");
    return {
      past: past.length > 0 ? look(past[0]) : "",
      live: live.length > 0 ? look(live.at(-1)) : "",
      dimmed: [...document.querySelectorAll("#terminal .term-row.past")].filter(
        (row) => Number(getComputedStyle(row).opacity) < 1,
      ).length,
    };
  });

  assert.ok(looks.past.length > 0, "a coloured line scrolled past");
  assert.ok(looks.live.length > 0, "and one of them is still on the screen");
  assert.equal(looks.dimmed, 0, "nothing in the scrollback is held back");
  assert.equal(looks.past, looks.live, "a colour reads the same above the fold as below it");

  await closeTerminalView();
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
