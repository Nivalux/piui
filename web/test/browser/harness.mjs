// @ts-check

/** A server, a page and the helpers, one set per browser test file. */

import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const binary = path.join(root, "zig-out", "bin", "piui");
const fakePi = path.join(here, "..", "fake-pi.mjs");
const token = "f".repeat(40);

const require = createRequire(import.meta.url);

/** @type {any} */
let chromium = null;
/** @type {any} */ let runner = null;
/** @type {any} */ let page = null;
/** @type {import("node:child_process").ChildProcess | null} */ let server = null;
let base = "";
/** @type {string[]} */ const crashes = [];

/** A folder that really exists, so a session can claim it as its project. */
let wiredProject = "";
/** @type {string} */
let sessionsDir = "";
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
 * Type a folder into the picker and make sure it is still there when Enter follows, because the
 * picker paints its own starting folder into the field while that typing is landing.
 *
 * @param {string} cwd
 */
async function pickerTakes(cwd) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.fill("#dir-field", cwd);
    await page.waitForTimeout(150);
    if ((await page.inputValue("#dir-field")) === cwd) return;
  }
  throw new Error(`the folder picker would not take ${cwd}`);
}

/**
 * Open a chat in a folder of the reader's own, the way +Project does it. The chat before it can
 * already sit in the same folder, so the tab has to move as well as the folder line.
 *
 * @param {string} cwd
 */
async function openProjectChat(cwd) {
  const was = await page.evaluate(() => localStorage.getItem("piui:tab") ?? "");
  await page.click("#new-project");
  await page.waitForSelector("#dir-field");
  await pickerTakes(cwd);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    /** @param {{want: string, gone: string}} want */
    ({ want, gone }) =>
      document.getElementById("tab-cwd")?.textContent === want && (localStorage.getItem("piui:tab") ?? "") !== gone,
    { want: cwd, gone: was },
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

/** Wait for a toast that says this, not for whatever toast is already up. */
const toastSays = async (/** @type {RegExp} */ pattern) =>
  page.waitForFunction(
    (/** @type {string} */ want) => new RegExp(want).test(String(document.getElementById("toast")?.textContent ?? "")),
    pattern.source,
    { timeout: 10000 },
  );

/** What the machine's clipboard holds right now. */
function clipboard() {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** @param {string} text */
function hold(text) {
  return page.evaluate((want) => navigator.clipboard.writeText(want), text);
}

/**
 * Wait for a copy to land. A button, an OSC 52 escape and a paste all reach the
 * clipboard through a round trip the test cannot see, so one read is too early.
 *
 * @param {string} needle
 */
async function clipboardHolds(needle) {
  const landed = await page
    .waitForFunction(
      /** @param {string} want */
      async (want) => (await navigator.clipboard.readText()).includes(want),
      needle,
      { timeout: 3000 },
    )
    .then(
      () => true,
      () => false,
    );
  assert.ok(landed, `the clipboard held "${await clipboard()}", not "${needle}"`);
}

function activeTab() {
  return page.evaluate(() => {
    const row = /** @type {HTMLElement | null} */ (document.querySelector("#tab-list .tab.active"));
    return row ? String(row.dataset.tab) : "";
  });
}

/**
 * Assert a selector is already in the page, so a wait that could never succeed
 * fails at once instead of running out its timeout.
 *
 * @param {string} selector
 */
async function present(selector) {
  const found = await page.evaluate((sel) => !!document.querySelector(sel), selector);
  assert.ok(found, `${selector} is not in the page`);
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

export async function start() {
  if (blocked) return;

  fs.chmodSync(fakePi, 0o755);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piui-browser-"));
  fs.writeFileSync(path.join(dir, "token"), token);

  const sessions = path.join(dir, "sessions");
  sessionsDir = sessions;
  fs.mkdirSync(sessions, { recursive: true });
  wiredProject = path.join(dir, "wired-project");
  fs.mkdirSync(wiredProject, { recursive: true });
  // Old header, young last line: the sidebar has to sort on the latter.
  const wired = path.join(sessions, "2026-11-01T00-00-00-000Z_wired.jsonl");
  writeSession(wired, {
    cwd: wiredProject,
    first: "explain the pi wiring",
    header: "2026-11-01T00:00:00.000Z",
    last: "2026-12-01T09:00:00.000Z",
  });
  writeSession(path.join(sessions, "2026-11-04T00-00-00-000Z_branch-one.jsonl"), {
    cwd: wiredProject,
    first: "explain the pi wiring",
    header: "2026-11-04T00:00:00.000Z",
    last: "2026-11-21T09:00:00.000Z",
    parent: wired,
  });
  writeSession(path.join(sessions, "2026-11-05T00-00-00-000Z_branch-two.jsonl"), {
    cwd: wiredProject,
    first: "explain the pi wiring",
    header: "2026-11-05T00:00:00.000Z",
    last: "2026-11-22T09:00:00.000Z",
    parent: wired,
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
    git(gitProject, ["init", "-q", "-b", "main"]);
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
  if (process.env.PIUI_SERVER_LOG) {
    server.stderr?.setEncoding("utf8").on("data", (chunk) => process.stdout.write(`  [piui] ${chunk}`));
  } else server.stderr?.resume();
  await waitForServer();

  runner = await chromium.launch({
    executablePath: process.env.PIUI_CHROMIUM,
    timeout: 30000,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  page = await runner.newPage({ viewport: { width: 1280, height: 800 } });
  // Nothing in this file may wait on a browser that stopped answering: playwright's own default
  // is thirty seconds a call, and a call left without one waits forever.
  page.setDefaultNavigationTimeout(20000);
  page.setDefaultTimeout(20000);
  page.on("pageerror", (/** @type {unknown} */ error) => crashes.push(String(error)));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });

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
  // Every file starts with a chat open, so no test depends on the one before it.
  await page.click("#new-chat");
  await page.waitForSelector("#tab-list .tab");
}

export async function stop() {
  if (runner) {
    await settled(runner.close(), 5000);
  }
  if (server) server.kill("SIGKILL");
}

/** Wait for a shutdown to finish, but never longer than the clock it is given. */
/** @param {Promise<unknown>} work @param {number} ms */
function settled(work, ms) {
  return Promise.race([
    work.catch(() => {}),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]);
}

/**
 * A session file with a header older than its last line, which is what the
 * sidebar has to sort on.
 *
 * @param {string} file
 * @param {{cwd: string, first: string, header: string, last: string, parent?: string,
 *   compaction?: {summary: string, tokensBefore: number, at: string}}} spec
 */
function writeSession(file, spec) {
  const header = { type: "session", cwd: spec.cwd, timestamp: spec.header };
  if (spec.parent) header.parentSession = spec.parent;
  const lines = [
    JSON.stringify(header),
    JSON.stringify({
      type: "message",
      timestamp: spec.header,
      message: { role: "user", content: [{ type: "text", text: spec.first }] },
    }),
  ];
  if (spec.compaction) {
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: spec.compaction.at,
        message: {
          role: "compactionSummary",
          summary: spec.compaction.summary,
          tokensBefore: spec.compaction.tokensBefore,
        },
      }),
    );
  }
  lines.push(
    JSON.stringify({
      type: "message",
      timestamp: spec.last,
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }),
  );
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

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

// ----------------------------------------------------------- terminal views

/** Click the + tab until a menu item with this label is in the page. */
async function openTerminalTab() {
  await page.waitForSelector("#new-item", { state: "attached" });
  await page.click("#new-item");
}

export {
  activeTab,
  base,
  binary,
  blocked,
  clipboard,
  clipboardHolds,
  chatId,
  closeTerminalView,
  commandsFile,
  crashes,
  fakePi,
  freePort,
  gap,
  git,
  gitProject,
  hold,
  goneProject,
  here,
  idle,
  menuHangsUnder,
  noGit,
  onePixelPng,
  openFreshChat,
  openProjectChat,
  openTerminalTab,
  overflow,
  page,
  present,
  readCommands,
  root,
  runTurn,
  runner,
  sessionsDir,
  showPanel,
  sidebarIds,
  switchTo,
  toastSays,
  token,
  waitForServer,
  wiredProject,
  writeSession,
};
