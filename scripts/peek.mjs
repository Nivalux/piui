#!/usr/bin/env node

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binary = path.join(root, "zig-out/bin/piui");

/** @type {Record<string, string | boolean>} */
const options = {};
const argv = process.argv.slice(2).filter((arg) => arg.length > 0);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!arg.startsWith("--")) {
    options.session = arg;
    continue;
  }
  const named = arg.slice(2);
  const split = named.indexOf("=");
  if (split > 0) {
    options[named.slice(0, split)] = named.slice(split + 1);
    continue;
  }
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) options[named] = true;
  else options[named] = next;
  i += 1;
}

if (options.help) {
  console.log(
    [
      "usage: node scripts/peek.mjs [session.jsonl] [option]",
      "",
      "  --grep <text>   centre the listing on the first block holding text",
      "  --lines <n>     blocks to print around the match (default 8, all if no --grep)",
      "  --web <dir>     serve the frontend from disk instead of the embedded one",
      "  --pi <path>     pi binary (default: the one on PATH)",
      "  --shot <file>   also write a screenshot of the transcript",
      "  --keep          leave the temporary directory in place and say where",
    ].join("\n"),
  );
  process.exit(0);
}

const fail = (/** @type {string} */ message) => {
  console.error(`peek: ${message}`);
  process.exit(1);
};

if (!fs.existsSync(binary)) fail(`no server binary at ${binary} — run just build first`);
const require = createRequire(path.join(root, "web/test/x.js"));
let chromium;
try {
  chromium = require(/** @type {string} */ (process.env.PLAYWRIGHT_CORE ?? "playwright-core")).chromium;
} catch (error) {
  fail(`playwright-core is not importable — run this inside the nix shell (${String(error).slice(0, 80)})`);
}
const browserPath = process.env.PIUI_CHROMIUM ?? "";
if (!fs.existsSync(browserPath)) fail("no chromium — run this inside the nix shell");

/** The newest chat stored for a directory, in the shape pi keeps them. */
function newest(cwd) {
  const slug = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\]/g, "-")}--`;
  const dir = path.join(os.homedir(), ".pi/agent/sessions", slug);
  if (!fs.existsSync(dir)) fail(`no session store under ${dir}`);
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (files.length === 0) fail(`${dir} holds no chat`);
  return path.join(dir, files[0].name);
}

const source = options.session ? path.resolve(String(options.session)) : newest(root);
if (!fs.existsSync(source)) fail(`no such session: ${source}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piui-peek-"));
const token = "0".repeat(40);
let server = null;
let exitCode = 0;

/** A port the operating system just left free. */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = /** @type {net.AddressInfo} */ (probe.address()).port;
      probe.close(() => resolve(port));
    });
  });
}

async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const answer = await fetch(url);
      if (answer.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server?.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  if (!options.keep) fs.rmSync(dir, { recursive: true, force: true });
}

try {
  const store = path.join(dir, "sessions", path.basename(path.dirname(source)));
  fs.mkdirSync(store, { recursive: true });
  const copy = path.join(store, path.basename(source));
  fs.copyFileSync(source, copy);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const args = [
    "--addr",
    `127.0.0.1:${port}`,
    "--token",
    token,
    "--sessions",
    path.join(dir, "sessions"),
    "--scratch",
    path.join(dir, "scratch"),
    "--config",
    path.join(dir, "config.json"),
    "--idle",
    "0",
  ];
  if (options.web) args.push("--web", path.resolve(String(options.web)));
  if (options.pi) args.push("--pi", path.resolve(String(options.pi)));

  const log = fs.openSync(path.join(dir, "server.log"), "a");
  server = spawn(binary, args, { cwd: root, stdio: ["ignore", log, log] });
  server.on("exit", (code, signal) => {
    if (code !== 0 && code !== null && !signal) console.error(`peek: the server left with ${code}`);
  });

  if (!(await ready(`${base}/api/health`))) {
    console.error(fs.readFileSync(path.join(dir, "server.log"), "utf8").slice(-2000));
    fail("the server did not answer on its new port");
  }

  const browser = await chromium.launch({ executablePath: browserPath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.on("pageerror", (error) => console.error(`peek: page error — ${String(error).slice(0, 200)}`));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      async (sent) => fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: sent }),
      JSON.stringify({ token }),
    );
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#session-list .session", { timeout: 20000 });
    await page.locator("#session-list .session").first().click();
    await page.waitForFunction(() => document.querySelectorAll("#transcript .block").length > 0, null, { timeout: 30000 });
    await page.waitForTimeout(700);

    if (options.shot) await page.screenshot({ path: path.resolve(String(options.shot)), fullPage: false });

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#transcript .block")).map((node, index) => {
        const summary = node.querySelector("details > summary");
        const fold = node.querySelector("details");
        const state = node.querySelector(".state");
        return {
          index,
          kind: node.className.replace("block", "").trim(),
          open: fold ? fold.open : null,
          label: summary ? text(summary) : null,
          state: state ? text(state) : "",
          body: text(node),
          length: text(node).length,
        };
        /** @param {Element} element */
        function text(element) {
          return (element.textContent ?? "").replace(/\s+/g, " ").trim();
        }
      }),
    );

    const needle = options.grep ? String(options.grep) : "";
    const at = needle.length > 0 ? rows.findIndex((row) => row.body.includes(needle) || (row.label ?? "").includes(needle)) : -1;
    if (needle.length > 0 && at < 0) fail(`nothing in the transcript holds "${needle}"`);

    const span = Number(options.lines ?? 8);
    const window = needle.length > 0 ? rows.slice(Math.max(0, at - span), at + span + 1) : rows;
    console.log(`${source}\n${rows.length} blocks${needle.length > 0 ? `, match at #${at}` : ""}\n`);
    for (const row of window) {
      const where = row.index === at ? ">" : " ";
      const head = row.label ?? row.body.slice(0, 96);
      console.log(
        `${where} #${String(row.index).padStart(4)} ${row.kind.padEnd(9)} ${(row.open === null ? "" : row.open ? "[open] " : "[shut] ").padEnd(7)}${row.state.padStart(8)}  ${head.slice(0, 96)}`,
      );
      if (needle.length === 0 && row.kind === "text") console.log(`         ${row.body.slice(0, 96)}`);
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`peek: ${String(error && error.stack ? error.stack : error).split("\n").slice(0, 6).join("\n")}`);
  exitCode = 1;
} finally {
  await stop();
  if (options.keep) console.log(`kept ${dir}`);
}
process.exit(exitCode);
