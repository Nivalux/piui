// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import { countRows, diffLines, parseDiff, patchOf, pathFromGitLine, readHunkHeader, shrink } from "../diff.js";

const sample = `diff --git a/src/hub.zig b/src/hub.zig
index 1111111..2222222 100644
--- a/src/hub.zig
+++ b/src/hub.zig
@@ -10,7 +10,9 @@ pub fn open() void {
     let a = 1;
-    let b = 2;
+    let b = 3;
+    let c = 4;
     let d = 5;
diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
index 3333333..4444444 100644
--- a/old name.txt
+++ b/new name.txt
@@ -1,2 +1,2 @@
-first
+second
 same
diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`;

test("a diff splits into files with counts", () => {
  const files = parseDiff(sample);

  assert.equal(files.length, 3);
  assert.equal(files[0].path, "src/hub.zig");
  assert.equal(files[0].adds, 2);
  assert.equal(files[0].dels, 1);
  assert.equal(files[1].path, "new name.txt", "the b side of a rename is where the file lives");
  assert.equal(files[2].binary, true);
});

test("line numbers come out of the hunk header", () => {
  const files = parseDiff(sample);
  const rows = files[0].hunks[0].rows;

  assert.equal(rows[0].kind, "ctx");
  assert.equal(rows[0].old, 10);
  assert.equal(rows[0].new, 10);
  assert.equal(rows[1].kind, "del");
  assert.equal(rows[1].old, 11);
  assert.equal(rows[2].kind, "add");
  assert.equal(rows[2].new, 11);
  assert.equal(rows[4].new, 13);
});

test("one file's patch can be handed back to git apply", () => {
  const patch = patchOf(sample, "src/hub.zig");

  assert.match(patch, /^diff --git a\/src\/hub\.zig/);
  assert.ok(!patch.includes("new name.txt"), "stops at the next file");
  assert.match(patch, /\+    let c = 4;/);
});

test("hunk headers with and without counts both parse", () => {
  assert.deepEqual(readHunkHeader("@@ -12,7 +12,9 @@ fn open"), { old: 12, new: 12 });
  assert.deepEqual(readHunkHeader("@@ -1 +1,2 @@"), { old: 1, new: 1 });
  assert.deepEqual(readHunkHeader("no hunk"), { old: 0, new: 0 });
});

test("a rename with spaces keeps its path", () => {
  assert.equal(pathFromGitLine("diff --git a/old name.txt b/new name.txt"), "new name.txt");
  assert.equal(pathFromGitLine("diff --git a/x b/x"), "x");
  assert.equal(pathFromGitLine("not a git line"), "");
});

test("identical text stays context all the way down", () => {
  const rows = diffLines("a\nb\nc\n", "a\nb\nc\n");
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["ctx", "ctx", "ctx"],
  );
  assert.deepEqual(countRows(rows), { adds: 0, dels: 0 });
});

test("a line changed in the middle keeps its numbers on both sides", () => {
  const rows = diffLines("a\nb\nc\n", "a\nB\nc\n");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.old, row.new, row.text]),
    [
      ["ctx", 1, 1, "a"],
      ["del", 2, null, "b"],
      ["add", null, 2, "B"],
      ["ctx", 3, 3, "c"],
    ],
  );
});

test("appending only adds", () => {
  assert.deepEqual(countRows(diffLines("a\n", "a\nb\nc\n")), { adds: 2, dels: 0 });
});

test("shrinking keeps a few lines around every change", () => {
  const before = Array.from({ length: 40 }, (unused, index) => `line ${index}`).join("\n");
  const after = Array.from({ length: 40 }, (unused, index) => (index === 20 ? "changed" : `line ${index}`)).join("\n");

  const rows = shrink(diffLines(before, after));
  const changed = rows.filter((row) => row.kind === "add" || row.kind === "del");

  assert.equal(changed.length, 2);
  assert.ok(rows.some((row) => row.kind === "hunk"));
  assert.ok(rows.length < 15, `expected a collapsed diff, got ${rows.length} rows`);
});

test("a rewrite too large for exact matching still finishes", () => {
  const before = Array.from({ length: 1200 }, (unused, index) => `a${index}`).join("\n");
  const after = Array.from({ length: 1200 }, (unused, index) => `b${index}`).join("\n");

  assert.deepEqual(countRows(diffLines(before, after)), { adds: 1200, dels: 1200 });
});
