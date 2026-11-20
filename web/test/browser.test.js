// @ts-check

/**
 * Browser tests.
 *
 * These drive the real server and the real page in chromium, with a scripted
 * stand-in for pi (fake-pi.mjs) so they need no model, no key and no network
 * and behave the same on every run. They cover what only a browser can: that a
 * fold opens under the click while its row is being rewritten, that a closed
 * row says what it did, and that the page scrolls where it is supposed to.
 *
 * Outside the nix shell there is no chromium, so the whole file skips.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    { timeout: 15000 },
  );
}

/** The chat the sidebar has highlighted. */
function activeTab() {
  return page.evaluate(() => {
    const row = /** @type {HTMLElement | null} */ (document.querySelector("#tab-list .tab.active"));
    return row ? String(row.dataset.tab) : "";
  });
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
}

/**
 * @param {string} id
 */
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

  base = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["--config", path.join(dir, "config.json"), "--addr", `127.0.0.1:${port}`], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  assert.equal(titles.length, 2);
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
  assert.equal(await page.locator("#session-list .session").count(), 2);
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
  assert.equal(kinds.filter((/** @type {string} */ kind) => kind === "tool").length, 3);
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
    { timeout: 15000 },
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

  await page.fill("#dir-field", `${opened}sr`);
  await page.waitForFunction(() => document.querySelectorAll("#dir-list .dir-row").length === 1);
  const narrowed = await page.evaluate(() => document.querySelector("#dir-list .dir-row")?.getAttribute("data-path"));
  assert.equal(narrowed, `${opened.slice(0, -1)}/src`, "typing narrows the list");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const field = /** @type {HTMLInputElement | null} */ (document.getElementById("dir-field"));
    return String(field?.value ?? "").endsWith("/src/");
  });
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll("#dir-list .dir-row")];
    return rows.length > 0 && rows.every((row) => !String(row.textContent).includes("web"));
  });

  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (/** @type {number} */ count) => document.querySelectorAll("#tab-list .tab").length > count,
    tabs,
    { timeout: 15000 },
  );
  await page.waitForFunction(() => document.getElementById("dir-modal")?.hidden === true);
  assert.match(String(await page.textContent("#tab-cwd")), /\/src$/, "the chat runs in the chosen folder");
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
    { timeout: 15000 },
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

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
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
