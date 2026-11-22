// @ts-check

/** Browser tests. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const binary = path.join(root, "zig-out", "bin", "piui");
const fakePi = path.join(here, "fake-pi.mjs");
const token = "f".repeat(40);

const require = createRequire(import.meta.url);

/** @type {any} */
let chromium = null;
/** @type {any} */ let runner = null;
/** @type {any} */ let page = null;
/** @type {import("node:child_process").ChildProcess | null} */ let server = null;
let base = "";
/** @type {string[]} */ const crashes = [];

/** The chat the scroll tests grew long enough to overflow. */
let longTab = "";

/** A folder that really exists, so a session can claim it as its project. */
let wiredProject = "";
/** A project folder that was deleted after its chat was written. */
let goneProject = "";

/** A repository with one edit and one new file, for the diff panel. */
let gitProject = "";

/** Every command the stand-in for pi was sent, so a test can read what asked. */
let commandsFile = "";

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const ran = spawnSync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);
}

/**
 * Every command the stand-in for pi has been given so far, oldest first.
 *
 * @returns {any[]}
 */
function readCommands() {
  try {
    return fs
      .readFileSync(commandsFile, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Close the terminal through the ✕ of its tab in the view strip.
 */
async function closeTerminalView() {
  await page.click('#view-tabs .view:has(.view-tab:has-text("tty")) .view-close');
}

/** The id of the chat in view. */
function chatId() {
  return page.evaluate(() => localStorage.getItem("piui:tab") ?? "");
}

/**
 * Open a chat in a folder of the reader's own, the way +Project does it.
 *
 * @param {string} cwd
 */
async function openProjectChat(cwd) {
  await page.click("#new-project");
  await page.waitForSelector("#dir-field");
  await page.fill("#dir-field", cwd);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    /** @param {string} want */
    (want) => document.getElementById("tab-cwd")?.textContent === want,
    cwd,
    { timeout: 30000 },
  );
}

/**
 * Send a message and wait for the answer it produces. Waiting on the spinner
 * or on the running flag alone wins a beat too early, and the next message
 * then lands as steering instead of as a turn of its own.
 *
 * @param {string} message
 */
async function runTurn(message) {
  await idle();
  const before = await page.locator("#transcript .block.text").count();
  await page.fill("#input", message);
  await page.click("#send");
  await page.waitForFunction(
    (/** @type {number} */ count) => document.querySelectorAll("#transcript .block.text").length > count,
    before,
    { timeout: 30000 },
  );
}

/**
 * An answer lands a beat before Pi settles. A line typed into that gap is
 * filed as steering instead of as a turn of its own, so tests wait for the
 * chat row to stop spinning before they send one.
 */
function idle() {
  return page.waitForFunction(
    () => {
      const row = document.querySelector("#tab-list .tab.active");
      return row !== null && row.querySelector(".spinner") === null;
    },
    undefined,
    { timeout: 30000 },
  );
}

/** The chat the sidebar has highlighted. */
/** Wait for a toast that says this, not for whatever toast is already up. */
const toastSays = async (/** @type {RegExp} */ pattern) =>
  page.waitForFunction(
    (/** @type {string} */ want) => new RegExp(want).test(String(document.getElementById("toast")?.textContent ?? "")),
    pattern.source,
    { timeout: 10000 },
  );

function activeTab() {
  return page.evaluate(() => {
    const row = /** @type {HTMLElement | null} */ (document.querySelector("#tab-list .tab.active"));
    return row ? String(row.dataset.tab) : "";
  });
}

/** The chats in the sidebar, top to bottom. */
async function sidebarIds() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#tab-list .tab")).map((node) =>
      node instanceof HTMLElement ? node.dataset.tab : undefined,
    ),
  );
}

/**
 * The menu belongs under the dots that opened it. It once hung itself on the
 * far side of the window because it measured against the wrong box, and that
 * reads as a bug on every single open.
 *
 * @param {any} row a playwright locator
 */
async function menuHangsUnder(row) {
  const menu = await page.locator(".row-actions").boundingBox();
  const dots = await row.locator(".row-menu").boundingBox();
  assert.ok(menu && dots, "menu and dots are both on screen");
  assert.ok(
    Math.abs(menu.x + menu.width - (dots.x + dots.width)) < 24,
    `the menu's right edge sits at the dots, not ${(menu.x + menu.width - (dots.x + dots.width)).toFixed(1)}px away`,
  );
  assert.ok(menu.y >= dots.y - 1 && menu.y <= dots.y + dots.height + 40, "the menu hangs from its row");
}

/**
 * Open a chat of one's own and wait until the app is really sitting in it.
 * Clicking and typing without that wait lands the first message in whichever
 * chat was open before, because opening one is a round trip.
 */
async function openFreshChat() {
  const before = await activeTab();
  await page.click("#new-chat");
  await page.waitForFunction(
    (/** @type {string} */ id) => {
      const row = /** @type {HTMLElement | null} */ (document.querySelector("#tab-list .tab.active"));
      return row !== null && String(row.dataset.tab) !== id;
    },
    before,
    { timeout: 10000 },
  );
  return activeTab();
}

/** @param {string} id */
async function switchTo(id) {
  await page.click(`#tab-list .tab[data-tab="${id}"]`);
  await page.waitForFunction(
    /** @param {string} chat */
    (chat) => {
      const row = /** @type {HTMLElement | null} */ (document.querySelector("#tab-list .tab.active"));
      return row !== null && row.dataset.tab === chat;
    },
    id,
    { timeout: 10000 },
  );
}

/**
 * Put the side panel where the test needs it. Clicking blindly would toggle it
 * the other way whenever a previous test left it open.
 *
 * @param {boolean} open
 */
async function showPanel(open) {
  const visible = await page.evaluate(() => document.getElementById("side-panel")?.hasAttribute("hidden") === false);
  if (visible !== open) await page.click("#panel-toggle");
  await page.waitForFunction(
    /** @param {boolean} want */
    (want) => document.getElementById("side-panel")?.hasAttribute("hidden") !== want,
    open,
    { timeout: 10000 },
  );
}

/** How far the reading position sits above the newest block. */
function gap() {
  return page.evaluate(() => {
    const box = /** @type {HTMLElement} */ (document.getElementById("transcript"));
    return box.scrollHeight - box.scrollTop - box.clientHeight;
  });
}

/** How much of the transcript does not fit. */
function overflow() {
  return page.evaluate(() => {
    const box = /** @type {HTMLElement} */ (document.getElementById("transcript"));
    return box.scrollHeight - box.clientHeight;
  });
}

const blocked = (() => {
  if (!fs.existsSync(binary)) return `no server binary at ${binary} — run zig build first`;
  const target = process.env.PIUI_CHROMIUM ?? "";
  if (target.length === 0 || !fs.existsSync(target)) return "no chromium — run this inside the nix shell";
  try {
    chromium = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core").chromium;
  } catch (error) {
    return `playwright-core is not importable — run this inside the nix shell (${String(error).slice(0, 60)})`;
  }
  return false;
})();

/** Whether a repository can be built here at all. */
const noGit = (() => {
  const probe = spawnSync("git", ["--version"], { cwd: root });
  return probe.status !== 0 ? "no git — the diff panel cannot be tested" : false;
})();

before(async () => {
  if (blocked) return;

  fs.chmodSync(fakePi, 0o755);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piui-browser-"));
  fs.writeFileSync(path.join(dir, "token"), token);

  const sessions = path.join(dir, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  wiredProject = path.join(dir, "wired-project");
  fs.mkdirSync(wiredProject, { recursive: true });
  // Old header, young last line: the sidebar has to sort on the latter.
  writeSession(path.join(sessions, "2026-11-01T00-00-00-000Z_wired.jsonl"), {
    cwd: wiredProject,
    first: "explain the pi wiring",
    header: "2026-11-01T00:00:00.000Z",
    last: "2026-12-01T09:00:00.000Z",
  });
  writeSession(path.join(sessions, "2026-11-02T00-00-00-000Z_other.jsonl"), {
    cwd: "/srv/web",
    first: "nothing else at all",
    header: "2026-11-02T00:00:00.000Z",
    last: "2026-11-05T09:00:00.000Z",
  });

  // A chat whose project was deleted afterwards. Written first, then removed,
  // so the folder really is gone by the time the server reads the file.
  goneProject = path.join(dir, "gone-project");
  fs.mkdirSync(goneProject, { recursive: true });
  writeSession(path.join(sessions, "2026-11-03T00-00-00-000Z_gone.jsonl"), {
    cwd: goneProject,
    first: "a chat whose home is gone",
    header: "2026-11-03T00:00:00.000Z",
    last: "2026-11-06T09:00:00.000Z",
  });
  fs.rmSync(goneProject, { recursive: true, force: true });

  gitProject = path.join(dir, "git-project");
  if (!noGit) {
    fs.mkdirSync(gitProject, { recursive: true });
    fs.writeFileSync(path.join(gitProject, "notes.md"), "one\n");
    fs.writeFileSync(path.join(gitProject, "keep.txt"), "keep me\n");
    fs.writeFileSync(path.join(gitProject, "log.txt"), "start\n");
    fs.mkdirSync(path.join(gitProject, "sub"), { recursive: true });
    fs.writeFileSync(path.join(gitProject, "sub", "nested.md"), "deeper\n");
    git(gitProject, ["init", "-q"]);
    git(gitProject, ["config", "user.email", "piui@example.invalid"]);
    git(gitProject, ["config", "user.name", "piui"]);
    git(gitProject, ["add", "."]);
    git(gitProject, ["commit", "-qm", "start"]);
    fs.writeFileSync(path.join(gitProject, "notes.md"), "one\ntwo\n");
    fs.writeFileSync(path.join(gitProject, "fresh.md"), "brand new\n");
  }

  const port = await freePort();
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      server: {
        host: "127.0.0.1",
        port,
        pi: fakePi,
        sessions,
        scratch: path.join(dir, "scratch"),
        idle_seconds: 600,
      },
      ui: { theme: "dark", sidebar: true, files: true, show_thinking: true, send_on_enter: true, send_mode: "steer" },
    }),
  );

  commandsFile = path.join(dir, "commands.jsonl");
  base = `http://127.0.0.1:${port}`;
  // `PIUI_WEB=web` serves the client off disk instead of out of the binary, so
  // page work can be checked without rebuilding Zig for every edit. The suite
  // runs the embedded bytes, which is what ships.
  const live = process.env.PIUI_WEB;
  server = spawn(
    binary,
    ["--config", path.join(dir, "config.json"), "--addr", `127.0.0.1:${port}`, ...(live ? ["--web", live] : [])],
    {
      cwd: root,
      env: { ...process.env, PIUI_FAKE_COMMANDS: commandsFile },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.resume();
  server.stderr?.resume();
  await waitForServer();

  runner = await chromium.launch({
    executablePath: process.env.PIUI_CHROMIUM,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  page = await runner.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (/** @type {unknown} */ error) => crashes.push(String(error)));

  await page.goto(`${base}/`);
  await page.evaluate(
    async (/** @type {string} */ secret) =>
      fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: secret }),
      }),
    token,
  );
  await page.goto(`${base}/`);
  await page.waitForSelector("#new-chat");
});

after(async () => {
  if (runner) await runner.close().catch(() => {});
  if (server) server.kill();
});

test("the session list is ordered by its newest line", { skip: blocked }, async () => {
  await page.waitForSelector("#session-list .session");
  const titles = await page.locator("#session-list .session .session-title").allInnerTexts();
  assert.equal(titles[0], "explain the pi wiring", "the session with the newest last line comes first");
  assert.equal(titles.length, 3);
});

test("typing in the sidebar filters it the way fzf does", { skip: blocked }, async () => {
  await page.evaluate(() => /** @type {any} */ (document.activeElement)?.blur());
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "filter", "/ focuses the filter");

  await page.fill("#filter", "xplw");
  const titles = await page.locator("#session-list .session .session-title").allInnerTexts();
  assert.deepEqual(titles, ["explain the pi wiring"], "letters in order, gaps allowed");
  assert.ok((await page.locator("#session-list .session-title mark").count()) > 0, "the matched letters are marked");

  await page.fill("#filter", "qqqq");
  assert.equal(await page.locator("#session-list .session").count(), 0);

  await page.keyboard.press("Escape");
  assert.equal(await page.inputValue("#filter"), "");
  assert.equal(await page.locator("#session-list .session").count(), 3);
});

test("signing in lands in a chat with the composer in view", { skip: blocked }, async () => {
  assert.equal(await page.locator("#gate").count(), 0, "the token gate should be gone");
  assert.equal(await page.locator("#input").isVisible(), true);
  assert.equal(await page.locator("#send").isVisible(), true);
});

test("a turn draws thoughts, tools and an answer", { skip: blocked }, async () => {
  await page.click("#new-chat");
  await page.fill("#input", "run the scripted tools");
  await page.click("#send");

  await page.waitForSelector("#transcript .block.text >> text=Beide Tools");
  const kinds = await page
    .locator("#transcript .block")
    .evaluateAll((/** @type {Element[]} */ rows) =>
      rows.map((row) => String(row.className.replace("block ", ""))),
    );
  assert.ok(kinds.includes("thinking"), "thoughts should be a row of their own");
  assert.equal(kinds.filter((/** @type {string} */ kind) => kind === "tool").length, 4);
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

  const src = await shot.locator(".thumb").evaluate((/** @type {HTMLImageElement} */ node) => node.getAttribute("src") ?? "");
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
  const open = await page.locator("#transcript .block.thinking details").evaluate((/** @type {any} */ fold) => fold.open);
  assert.equal(open, false);
});

test("clicking a running tool opens it and keeps it open", { skip: blocked }, async () => {
  await page.fill("#input", "and now the long one");
  await page.click("#send");

  const row = page.locator("#transcript .block.tool", { hasText: "sleep 6" }).first();
  await row.locator(".spinner").waitFor({ state: "visible", timeout: 10000 });
  const summary = row.locator("details > summary");

  await summary.click();
  assert.equal(await row.locator("details").evaluate((/** @type {any} */ fold) => fold.open), true, "the click should open it");

  // The row is rewritten as output arrives; that must not close it again.
  await page.waitForTimeout(1300);
  assert.equal(await row.locator("details").evaluate((/** @type {any} */ fold) => fold.open), true, "streaming must not close it");

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
    assert.ok(
      Math.abs(pair[0] - pair[1]) < 1,
      `${where} keeps its width whatever it shows: ${JSON.stringify(pair)}`,
    );

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
      const time = Number(node.getAnimations()[0]?.currentTime ?? 0);
      const raw = getComputedStyle(node).animationDelay;
      const delay = Number.parseFloat(raw) * (raw.includes("ms") ? 1 : 1000);
      return time - delay;
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
      const behind = Math.abs((((angle - first - (at - atFirst)) % 900) + 900) % 900);
      return Math.min(behind, 900 - behind);
    }),
  );
  assert.ok(
    worst < 120,
    `the spinner keeps turning with the clock rather than starting over: ${turns.map(([angle, at]) => Math.round(angle - at))}`,
  );

  await row.locator(".spinner").waitFor({ state: "detached", timeout: 20000 });
  assert.equal(await row.locator("details").evaluate((/** @type {any} */ fold) => fold.open), true, "finishing must not close it");
  assert.match(await summary.innerText(), /6\.\ds/, "a finished row says how long it ran");
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
  await page.waitForFunction(
    () => /** @type {HTMLElement} */ (document.getElementById("queue")).hidden,
    null,
    { timeout: 5000 },
  );
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
  assert.equal(await row.locator("details").evaluate((/** @type {any} */ fold) => fold.classList.contains("error")), true);
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
  assert.ok((await gap()) < 60, "the arrow re-armed the follow");
});

test("opening a chat lands on its newest line", { skip: blocked }, async () => {
  const rows = await page.locator("#tab-list .tab").evaluateAll((/** @type {HTMLElement[]} */ list) =>
    list.map((row) => String(row.dataset.tab)),
  );
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
      return (
        box.scrollHeight - box.clientHeight > 150 &&
        box.scrollHeight - box.scrollTop - box.clientHeight < 5
      );
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

test("a chat that finishes in the background asks to be read", { skip: blocked }, async () => {
  /** @returns {Promise<any[]>} */
  const infos = async () => page.evaluate(() => fetch("/api/tabs").then((r) => r.json()));

  const here = (await infos()).map((info) => String(info.id));
  await page.click("#new-chat");
  await page.waitForTimeout(400);
  const other = (await infos()).map((info) => String(info.id)).find((id) => !here.includes(id));
  assert.ok(other, "a second chat should exist");

  await page.click(`#tab-list .tab[data-tab="${here[0]}"]`);
  await page.evaluate(
    async (/** @type {string} */ id) =>
      fetch(`/api/cmd?id=${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "prompt", message: "run the scripted tools" }),
      }),
    other,
  );

  await page.waitForFunction(
    async (/** @type {string} */ id) => {
      /** @type {any[]} */
      const list = await fetch("/api/tabs").then((r) => r.json());
      const info = list.find((t) => String(t.id) === id);
      return Boolean(info && !info.running && info.finishedMs > 0);
    },
    other,
    { timeout: 20000 },
  );

  const marked = `#tab-list .tab.unread[data-tab="${other}"]`;
  await page.waitForSelector(marked, { timeout: 12000 });
  assert.equal(await page.locator(`#tab-list .tab[data-tab="${here[0]}"]`).evaluate((/** @type {any} */ row) => row.classList.contains("unread")), false);

  await page.click(`#tab-list .tab[data-tab="${other}"]`);
  await page.waitForSelector(`#tab-list .tab.unread[data-tab="${other}"]`, { state: "detached", timeout: 5000 });
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

test("the project picker completes a path and opens a chat in it", { skip: blocked }, async () => {
  await page.click("#new-project");
  await page.waitForSelector("#dir-field");

  const opened = await page.inputValue("#dir-field");
  assert.ok(opened.endsWith("/"), "a folder is offered as a folder");

  await page.waitForSelector("#dir-list .dir-row");
  /** @type {string[]} */ const names = (await page.locator("#dir-list .dir-row").allInnerTexts())
    .map((/** @type {string} */ text) => text.replace("\u25b8", "").trim());
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
    const rows = [...document.querySelectorAll("#dir-list .dir-row")].map((row) => String(row.textContent).trim());
    return rows.length === 1 && rows[0].replace("\u25b8", "").trim() === "test";
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
      [...document.querySelectorAll("#session-list .session-title")].some((node) => node.textContent === "explain the pi wiring"),
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

test("both panels fold away and come back", { skip: blocked }, async () => {
  await showPanel(true);
  await showPanel(false);
  assert.ok(await page.locator("#panel-toggle").isVisible(), "the button that closed the panel stays reachable");

  await showPanel(true);

  await page.keyboard.press("Control+j");
  await page.waitForSelector("#side-panel", { state: "hidden" }, { timeout: 10000 });
  await page.keyboard.press("Control+j");
  await showPanel(true);

  await page.keyboard.press("Control+b");
  await page.waitForSelector("#shell.side-collapsed", { timeout: 10000 });
  await page.keyboard.press("Control+b");
  await page.waitForSelector("#shell:not(.side-collapsed)", { timeout: 10000 });

  await page.click("#sidebar-toggle");
  await page.waitForSelector("#shell.side-collapsed");
  await page.waitForSelector("#tab-list", { state: "hidden" });
  assert.ok(await page.locator("#sidebar-toggle").isVisible(), "and the same for the chat list");
  const widened = await page.evaluate(() => document.getElementById("transcript")?.clientWidth ?? 0);

  await page.click("#sidebar-toggle");
  await page.waitForSelector("#shell:not(.side-collapsed)");
  await page.waitForSelector("#tab-list .tab");
  const back = await page.evaluate(() => document.getElementById("transcript")?.clientWidth ?? 0);
  assert.ok(back < widened, "the chat gives the width back when the list returns");
});

test("the diff tab reads like git status and opens a patch beside the chat", { skip: blocked || noGit }, async () => {
  await openProjectChat(gitProject);
  await showPanel(true);
  await page.waitForFunction(() => document.querySelectorAll("#diff-body .st-row").length > 0, undefined, {
    timeout: 30000,
  });

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#diff-body .st-row")].map((row) => {
      const code = /** @type {HTMLElement} */ (row.querySelector(".st-code"));
      return `${code?.textContent} ${code?.className.replace("st-code st-", "")} ${row.querySelector(".st-path")?.textContent}`;
    }),
  );
  assert.ok(rows.includes("M mod notes.md"), `the edit is listed as modified: ${rows.join(", ")}`);
  assert.ok(rows.includes("? new fresh.md"), `what git never saw is listed as new: ${rows.join(", ")}`);

  const groups = (await page.locator("#diff-body .status-group").allInnerTexts())
    .map((/** @type {string} */ text) => text.trim().toLowerCase())
    .filter((/** @type {string} */ text) => text.length > 0);
  assert.deepEqual(groups, ["changes", "untracked"], "the two blocks `git status` would print");

  // What the diff is compared to only means something here, so the choice
  // lives with the tab rather than at the top of the window.
  assert.ok(await page.locator("#base").isVisible(), "the base sits inside the panel");
  assert.ok(await page.locator("#panel-files-tab").isVisible());

  await page.locator("#diff-body .st-row", { hasText: "notes.md" }).click();
  await page.waitForFunction(() => !document.getElementById("file-view")?.hasAttribute("hidden"));

  const tabs = (await page.locator("#view-tabs .view-tab").allInnerTexts()).map((/** @type {string} */ text) => text.trim());
  assert.equal(tabs.length, 2, "the patch sits next to the chat");
  assert.equal(tabs[1], "Δ notes.md");
  assert.ok(await page.locator("#composer").isHidden(), "a patch is not a place to send a message");

  await page.waitForFunction(() => document.querySelectorAll("#file-body .row").length > 0);
  const patch = await page.evaluate(() => ({
    added: [...document.querySelectorAll("#file-body .row.add .code")].map((cell) => cell.textContent),
    removed: [...document.querySelectorAll("#file-body .row.del .code")].map((cell) => cell.textContent),
    head: document.querySelector("#file-head .file-meta")?.textContent,
  }));
  assert.deepEqual(patch.added, ["two"], "only the new line is added");
  assert.deepEqual(patch.removed, [], "nothing was taken away");
  assert.equal(patch.head, "+1 −0");

  await page.locator("#view-tabs .view-tab").first().click();
  await page.waitForFunction(() => !document.getElementById("composer")?.hasAttribute("hidden"));
  assert.ok(await page.locator("#transcript").isVisible(), "and the chat is where it was");
});

test("the panel never covers the chat", { skip: blocked || noGit }, async () => {
  await openProjectChat(gitProject);
  await page.evaluate(() => document.getElementById("shell")?.classList.remove("side-collapsed"));
  await showPanel(true);
  await page.waitForFunction(() => document.querySelectorAll("#diff-body .st-row").length > 0, undefined, {
    timeout: 30000,
  });

  const boxes = await page.evaluate(() => {
    /** @param {string} selector */
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { left: Math.round(box.left), right: Math.round(box.right) };
    };
    return {
      panel: rect("#side-panel"),
      center: rect(".center"),
      stream: rect("#stream"),
      composer: rect("#composer"),
      window: { right: window.innerWidth },
    };
  });

  assert.ok(boxes.panel && boxes.center && boxes.stream && boxes.composer, "every box is on the page");
  const edge = /** @type {number} */ (/** @type {any} */ (boxes.panel).left);
  assert.ok(
    /** @type {any} */ (boxes.center).right <= edge + 1,
    `the middle stops where the panel starts: ${JSON.stringify(boxes)}`,
  );
  for (const name of ["stream", "composer"]) {
    assert.ok(
      /** @type {any} */ (boxes[name]).right <= edge + 1,
      `${name} does not reach under the panel: ${JSON.stringify(boxes)}`,
    );
  }
  assert.ok(boxes.window.right - edge > 200, "the panel keeps its own room");
});

test("the files tab lists the folder and opens what is clicked", { skip: blocked || noGit }, async () => {
  await showPanel(true);
  await page.click("#panel-files-tab");
  await page.waitForSelector("#file-list .file-row");

  const names = async () =>
    await page.evaluate(() => [...document.querySelectorAll("#file-list .file-row .file-name")].map((n) => n.textContent));

  assert.ok((await names()).includes("keep.txt"));
  assert.ok((await names()).includes("fresh.md"), "a file git never saw is listed too");
  assert.ok((await names()).includes("sub"), "a folder is a row of its own");
  assert.ok(!(await names()).includes("nested.md"), "what is inside it waits until the folder is opened");

  await page.locator("#file-list .file-row", { hasText: "sub" }).click();
  await page.waitForFunction(() => document.getElementById("file-crumbs")?.hidden === false);
  assert.deepEqual(await names(), ["..", "nested.md"], "one folder deep, with a way back");

  await page.locator("#file-crumbs .crumb-up").click();
  await page.waitForFunction(() => ![...document.querySelectorAll(".file-row .file-name")].some((n) => n.textContent === ".."));

  await page.fill("#file-filter", "ee");
  await page.waitForFunction(() => document.querySelectorAll("#file-list .file-row").length === 2);
  const narrowed = await page.evaluate(() =>
    [...document.querySelectorAll("#file-list .file-row .file-name")].map((n) => n.textContent),
  );
  assert.deepEqual(narrowed, ["keep.txt", "nested.md"], "typing searches the whole tree, near ones first");
  const dirs = await page.evaluate(() =>
    [...document.querySelectorAll("#file-list .file-row")].map((row) => row.querySelector(".file-dir")?.textContent ?? ""),
  );
  assert.deepEqual(dirs, ["", "sub"], "a file says where it lives only when that is not here");
  assert.ok(
    await page.evaluate(() => document.querySelector("#file-list .file-row .file-name mark") !== null),
    "the letters that matched are the ones typed",
  );

  await page.fill("#file-filter", "");
  await page.waitForFunction(() => document.querySelectorAll("#file-list .file-row").length > 1);
  await page.locator("#file-list .file-row", { hasText: "fresh.md" }).first().click();
  await page.locator("#file-list .file-row", { hasText: "notes.md" }).click();

  const labels = async () =>
    (await page.locator("#view-tabs .view-tab").allInnerTexts()).map((/** @type {string} */ text) => text.trim());

  assert.deepEqual(await labels(), ["git-project", "notes.md"], "clicking through a list reuses one tab");
  assert.ok(
    await page.evaluate(() => document.querySelector("#view-tabs .view.on .view-tab.preview") !== null),
    "the borrowed tab says so in italic",
  );

  await page.locator("#view-tabs .view.on .view-tab").click();
  assert.ok(
    await page.evaluate(() => document.querySelector("#view-tabs .view-tab.preview") === null),
    "clicking the tab is what keeps the file",
  );

  await page.locator("#file-list .file-row", { hasText: "keep.txt" }).click();
  assert.deepEqual(
    await labels(),
    ["git-project", "notes.md", "keep.txt"],
    "with nothing on loan, the next file gets a tab of its own",
  );

  await page.waitForFunction(() => document.querySelectorAll("#file-body .code-line").length >= 1);
  const read = await page.evaluate(() => ({
    lines: [...document.querySelectorAll("#file-body .code-line .lc")].map((cell) => cell.textContent),
    patch: document.querySelectorAll("#file-body .row").length,
  }));
  assert.deepEqual(read.lines, ["keep me"], "the whole file, not a piece of it");
  assert.equal(read.patch, 0, "a file from the folder is the file, not its diff");

  await page.locator("#view-tabs .view").nth(2).locator(".view-tab").click({ button: "middle" });
  await page.waitForFunction(() => document.querySelectorAll("#view-tabs .view").length === 2, undefined, {
    timeout: 10000,
  });

  for (let at = await page.locator("#view-tabs .view").count(); at > 1; at -= 1) {
    await page.locator("#view-tabs .view").nth(at - 1).locator(".view-close").click();
  }
  await page.waitForFunction(() => document.querySelectorAll("#view-tabs .view").length === 1);
  await page.waitForFunction(() => !document.getElementById("composer")?.hasAttribute("hidden"));

  await page.keyboard.press("Escape");
  await page.waitForSelector("#side-panel", { state: "hidden" }, { timeout: 10000 });
  await showPanel(true);
});

test("the diff panel notices a turn that changed the folder", { skip: blocked || noGit }, async () => {
  await openProjectChat(gitProject);
  await showPanel(true);
  await page.click("#panel-diff-tab");
  await page.waitForFunction(() => (document.getElementById("panel-diff-tab")?.getBoundingClientRect().width ?? 0) > 0);
  await page.waitForFunction(() => document.querySelectorAll("#diff-body .st-row").length > 0);
  const listed = () => page.evaluate(() => [...document.querySelectorAll("#diff-body .st-row .st-path")].map((p) => p.textContent));
  assert.ok(!(await listed()).includes("log.txt"), "the note is not there yet");

  await runTurn("scrawl a note");

  await page.waitForFunction(
    () => [...document.querySelectorAll("#diff-body .st-row .st-path")].some((p) => p.textContent === "log.txt"),
    undefined,
    { timeout: 30000 },
  );
});

test("a picture joins the message from the folder or from a drag", { skip: blocked }, async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAUCAYAAADskT9PAAAANUlEQVR4nGN4kOP1Hx4WEZXCiynVzzDqgFEHjDqA1hYQ0j/qgFEHjDph4MuBUQeMOmCgHQAARi3M/RQC5ogAAAAASUVORK5CYII=";
  const picture = path.join(os.tmpdir(), "piui-picture.png");
  fs.writeFileSync(picture, png, "base64");

  /**
   * @param {string} name
   * @param {string} type
   */
  const drop = (name, type) =>
    page.evaluate(
      /** @param {{name: string, type: string}} given */
      (given) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new TextEncoder().encode("something")], given.name, { type: given.type }));
        document
          .getElementById("composer")
          ?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
      },
      { name, type },
    );

  await openFreshChat();

  await page.setInputFiles("#attach-input", picture);
  await page.waitForSelector("#attachments .attachment img");
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector("#attachments .attachment img")?.getAttribute("src")?.startsWith("data:image/png") ?? false,
    ),
    "the picked picture is there to look at before it is sent",
  );

  await drop("dropped.png", "image/png");
  await page.waitForFunction(() => document.querySelectorAll("#attachments .attachment").length === 2);

  await drop("notes.txt", "text/plain");
  await page.waitForFunction(() => document.querySelector("#attachments .attach-note") !== null);
  assert.equal(
    await page.evaluate(() => document.querySelectorAll("#attachments .attachment").length),
    2,
    "a file that cannot go to pi is said so rather than dropped on the floor",
  );

  for (let at = 0; at < 2; at += 1) {
    await page.locator("#attachments .attachment .button").first().click();
  }
  assert.equal(await page.locator("#attachments .attachment").count(), 0, "both chips came back off");
  assert.equal(
    await page.locator("#attachments .attach-note").count(),
    1,
    "the note about the file that was refused stays where it can be read",
  );
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
  assert.ok(churn <= 1, `the chat list was rebuilt ${churn} times while an answer streamed`);

  // A press is not a point in time: the row has to still be there when the
  // finger comes back up.
  const box = await page.locator(`#tab-list .tab[data-tab="${second}"]`).boundingBox();
  assert.ok(box, "the other chat is in the list");
  await page.mouse.move(box.x + 24, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.mouse.up();

  await page.waitForFunction(
    /** @param {string} want */
    (want) => document.querySelector("#tab-list .tab.active")?.getAttribute("data-tab") === want,
    second,
    { timeout: 10000 },
  );
});

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
  assert.equal(await row.locator(".state").innerText(), "4.2s", "the tool's own number, not the gap between two frames");
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

/**
 * A session file with a header older than its last line, which is what the
 * sidebar has to sort on.
 *
 * @param {string} file
 * @param {{cwd: string, first: string, header: string, last: string}} spec
 */
function writeSession(file, spec) {
  const lines = [
    JSON.stringify({ type: "session", cwd: spec.cwd, timestamp: spec.header }),
    JSON.stringify({
      type: "message",
      timestamp: spec.header,
      message: { role: "user", content: [{ type: "text", text: spec.first }] },
    }),
    JSON.stringify({
      type: "message",
      timestamp: spec.last,
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const reply = await fetch(`${base}/api/health`);
      if (reply.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not come up on ${base}`);
}

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

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

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
  assert.ok(
    await page.evaluate(
      () =>
        ((/** @type {HTMLImageElement | null} */ (document.querySelector("#attachments .attachment img"))
        )?.naturalWidth ?? 0) > 0,
    ),
    "the dropped bytes decoded",
  );

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
  assert.deepEqual(await page.locator(".row-action").allInnerTexts(), [
    "Copy path",
    "Archive into sessions",
  ]);
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

test("a session row offers its folder without opening the chat", async () => {
  const before = await activeTab();
  const row = page.locator(".session").first();

  await row.locator(".row-menu").click();
  await page.waitForSelector(".row-actions", { state: "visible" });
  await menuHangsUnder(row);
  assert.deepEqual(await page.locator(".row-action").allInnerTexts(), ["Copy path"]);
  assert.equal(await activeTab(), before, "the chat behind it stayed put");

  await page.locator(".row-action", { hasText: "Copy path" }).click();
  await toastSays(/copied \//);
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
  const reloads = () => page.waitForFunction((/** @type {number} */ want) => Number(sessionStorage.getItem("piui-reloads") ?? 0) >= want, 1, { timeout: 15000 });
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

test("the counters sit in their own band above the editor, even when narrow", { skip: blocked }, async () => {
  await openFreshChat();
  await runTurn("run the scripted tools");

  await page.setViewportSize({ width: 420, height: 900 });
  try {
    // The band only takes a line when it has something to say.
    await page.waitForFunction(() => document.getElementById("meter-bar")?.hidden === false, null, {
      timeout: 10000,
    });

    /** Where the counters, the editor and its buttons ended up. */
    const edges = await page.evaluate(() => {
      /** @param {string} sel */
      const box = (sel) => {
        const node = /** @type {HTMLElement | null} */ (document.querySelector(sel));
        if (!node) throw new Error(`no ${sel}`);
        return node.getBoundingClientRect();
      };
      return {
        view: window.innerWidth,
        meterTop: box("#meter-bar").top,
        meterBottom: box("#meter-bar").bottom,
        meterLeft: box("#meter-bar").left,
        composerTop: box("#composer").top,
        modelBottom: box("#model").bottom,
        sendLeft: box("#send").left,
        sendRight: box("#send").right,
        attachLeft: box("#attach").left,
        attachRight: box("#attach").right,
      };
    });

    assert.ok(edges.attachLeft >= 0 && edges.attachRight <= edges.view, "attach is inside the window");
    assert.ok(edges.sendLeft >= 0 && edges.sendRight <= edges.view, "send is inside the window");
    assert.ok(edges.meterBottom <= edges.composerTop + 1, "the counters are above the editor");
    assert.ok(edges.meterLeft >= 0, "and none of them hangs off the left edge");
    assert.ok(edges.modelBottom > edges.meterBottom, "the pickers stayed in the editor, below them");
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page
      .waitForFunction(() => !document.getElementById("shell")?.classList.contains("tight"), null, { timeout: 5000 })
      .catch(() => {});
  }
});

test("a window too narrow for both gives the chat the pixels", { skip: blocked }, async () => {
  // The setting decides, not the current fold: a window that is holding the
  // panel out on its own must not be answered with a click that closes it for
  // good, which is exactly what a click on the toggle would do then.
  await page.evaluate(() => {
    if (document.getElementById("side-panel")?.hidden) document.getElementById("panel-toggle")?.click();
  });
  await page.waitForFunction(
    () =>
      document.getElementById("side-panel")?.hidden === false &&
      !document.getElementById("shell")?.classList.contains("tight"),
    null,
    { timeout: 10000 },
  );

  const wide = await page.evaluate(() => ({
    panel: document.querySelector("#side-panel")?.clientWidth ?? 0,
    work: document.querySelector("#work")?.clientWidth ?? 0,
  }));
  assert.ok(wide.panel > 200, "the panel is out at a normal width");

  await page.setViewportSize({ width: 760, height: 900 });
  try {
    await page.waitForFunction(
      () => {
        const at = document.getElementById("side-panel");
        return at ? getComputedStyle(at).display === "none" : true;
      },
      null,
      { timeout: 5000 },
    );
    const chat = await page.evaluate(() => ({
      work: document.querySelector("#work")?.clientWidth ?? 0,
      composer: document.querySelector("#composer")?.clientWidth ?? 0,
    }));
    assert.ok(chat.work < wide.work, "the window really did get smaller");
    assert.ok(chat.composer >= chat.work - 2, "and the chat kept the whole row, panel or no panel");
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }

  await page.waitForFunction(
    () => {
      const at = document.getElementById("side-panel");
      return at ? getComputedStyle(at).display !== "none" : false;
    },
    null,
    { timeout: 5000 },
  );
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});

// ----------------------------------------------------------- terminal views

/** Click the + tab until a menu item with this label is in the page. */
async function pickNewItem(/** @type {string} */ label) {
  await page.waitForSelector("#new-item", { state: "attached" });
  await page.click("#new-item");
  await page.waitForSelector(".row-action", { timeout: 5000 });
  await page.click(`.row-action:has-text("${label}")`);
}

test("a terminal opens in the project and answers what you type", { skip: blocked }, async () => {
  await openProjectChat(gitProject);
  const rows = await page.evaluate(() => document.querySelectorAll("#tab-list .tab").length);

  // Something in the chat to come back to afterwards.
  await page.fill("#input", "what folder is this");
  await page.click("#send");
  await page.waitForSelector("#stream .block", { timeout: 10000 });

  await pickNewItem("Terminal in this project");

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
    (want) => [...document.querySelectorAll(".term-screen")].map((n) => n.textContent).join("\n").includes(want),
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
  await pickNewItem("Terminal in this project");
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
