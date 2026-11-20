import { test } from "node:test";
import assert from "node:assert/strict";
import { chosen, splitTyping, step, suggestions } from "../dirview.js";

/** @param {string[]} names */
const folders = (names) => names.map((name) => ({ name, path: `/app/${name}` }));

test("the cursor walks the list and wraps at both ends", () => {
  assert.equal(step(3, -1, 1), 0, "the first arrow lands on the first row");
  assert.equal(step(3, 0, 1), 1);
  assert.equal(step(3, 2, 1), 0, "past the bottom it starts again at the top");
  assert.equal(step(3, 0, -1), 2, "and above the top it lands at the bottom");
  assert.equal(step(0, 0, 1), -1, "an empty list has no cursor");
});

test("a path being typed splits into the folder to list and the words to filter", () => {
  assert.deepEqual(splitTyping("/srv/app/"), { base: "/srv/app", needle: "" });
  assert.deepEqual(splitTyping("/srv/ap"), { base: "/srv", needle: "ap" });
  assert.deepEqual(splitTyping("/"), { base: "/", needle: "" });
  assert.deepEqual(splitTyping(""), { base: "/", needle: "" });
  assert.deepEqual(splitTyping("tmp"), { base: "/", needle: "tmp" }, "a field cleared mid-edit still filters");
});

test("typing narrows the folders the way fzf does", () => {
  const dirs = folders(["src", "tests", "web", "docs"]);

  assert.deepEqual(
    suggestions(dirs, "").map((hit) => hit.item.name),
    ["src", "tests", "web", "docs"],
    "nothing typed keeps the order the server sent",
  );
  assert.deepEqual(
    suggestions(dirs, "s").map((hit) => hit.item.name),
    ["src", "tests", "docs"],
    "web has no s; the front of a name beats its middle",
  );
  assert.deepEqual(suggestions(dirs, "ts").map((hit) => hit.item.name), ["tests"], "letters in order only");
  assert.deepEqual(suggestions(dirs, "est").map((hit) => hit.item.name), ["tests"], "letters from the middle");
  assert.equal(suggestions(dirs, "zzz").length, 0);
  const hit = suggestions(dirs, "w")[0];
  assert.ok(hit && hit.ranges.length > 0, "a hit carries the ranges to highlight");
});

test("a keystroke means the highlighted folder, or what stands in the field", () => {
  const rows = folders(["src", "web"]);

  assert.equal(chosen(rows, 1, "/app/"), "/app/web");
  assert.equal(chosen(rows, -1, "/app/app/"), "/app/app", "the trailing slash only marks a folder");
  assert.equal(chosen(rows, 9, "/app/app"), "/app/app", "a cursor past the end is no cursor");
  assert.equal(chosen(rows, -1, "  "), "/", "an empty field is the root, not nothing");
});
