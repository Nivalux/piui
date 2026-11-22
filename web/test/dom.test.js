// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * The page wires itself up by looking ids up in one map, so two things can go
 * wrong and both are invisible until someone clicks: a key that the map does
 * not have (`el.kill` with no `kill` entry, which throws in the middle of
 * `wire`) and a map entry whose node is not in the document.
 */

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const build = readFileSync(new URL("../../build.zig", import.meta.url), "utf8");
const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");

const block = app.split("const ids = {")[1]?.split("};")[0] ?? "";

/** @type {Map<string, string>} */
const mapped = new Map([...block.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

/** @type {Set<string>} */
const used = new Set([...app.matchAll(/\bel\.([A-Za-z_]\w*)/g)].map((m) => m[1]));

test("the id map is read from app.js", () => {
  assert.ok(mapped.size > 10, `only ${mapped.size} entries found`);
});

test("every el.<key> the app touches is in the id map", () => {
  const missing = [...used].filter((key) => !mapped.has(key)).sort();
  assert.deepEqual(missing, [], `app.js touches ${missing.join(", ")} but the id map has no such entry`);
});

test("every id in the map has a node in index.html", () => {
  const missing = [...mapped.values()].filter((id) => !htmlIds.has(id)).sort();
  assert.deepEqual(missing, [], `index.html has no node for ${missing.join(", ")}`);
});

// The binary embeds whatever sits in web/, so an import that points at a file
// that is not there is the only way the page can ship a 404.
test("every module app.js imports is a file in web/", () => {
  const imports = [...app.matchAll(/from "\.\/([\w.]+)"/g)].map((m) => m[1]);
  assert.ok(imports.length > 3, "found no imports");
  for (const name of imports) {
    assert.ok(existsSync(new URL(`../${name}`, import.meta.url)), `app.js imports ./${name}, which web/ does not contain`);
  }
});

test("the build lists the assets instead of naming them", () => {
  assert.match(build, /fn webAssets/);
  assert.match(build, /addCopyFile/);
  assert.doesNotMatch(build, /@embedFile\("\.\/app\.js"\)/, "build.zig spells out a file the folder already names");
});

test("hidden really hides, whatever a class wants", () => {
  // `#settings-modal` is `position: fixed; inset: 0`: the moment a `display`
  // rule beats the `hidden` attribute it holds the whole page hostage and
  // swallows every click. The stylesheet wins that fight with `!important`.
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);

  const hidden = [...html.matchAll(/<\w+[^>]*class="([^"]*)"[^>]*\shidden[\s>]/g)].map((m) => m[1].split(/\s+/));
  assert.ok(hidden.length > 3, `nur ${hidden.length} versteckte Knoten gefunden`);
  for (const classes of hidden) {
    for (const name of classes) {
      const rule = css.match(new RegExp(`\\.${name}\\b[^{]*\\{([^}]*)\\}`));
      const display = rule?.[1].match(/display:[^;]*!important/);
      assert.ok(!display, `.${name} erzwingt ${display}`);
    }
  }
});

test("the page starts dark and names its script as a module", () => {
  assert.match(html, /<html[^>]*data-theme="dark"/);
  assert.match(html, /<script type="module" src="\/app\.js"/);
});
