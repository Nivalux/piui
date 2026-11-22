// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseOf,
  closeFile,
  dirOf,
  fileRows,
  fileTree,
  numberLines,
  openDiff,
  openFile,
  pinView,
  statusGroups,
  trailOf,
} from "../panel.js";

/** @type {import("../panel.js").View[]} */
const one = [{ kind: "chat" }];

test("a file opens beside the chat, once", () => {
  const first = openFile(one, "src/app.js");
  assert.equal(first.active, 1);
  assert.equal(first.views.length, 2);

  const again = openFile(first.views, "src/app.js");
  assert.equal(again.views.length, 2, "the same path is focused rather than opened twice");
  assert.equal(again.active, 1);

  const second = openFile(again.views, "web/app.js");
  assert.equal(second.active, 2);
  assert.equal(second.views.length, 3);
});

test("closing a view leaves the reader where they were looking", () => {
  /** @type {import("../panel.js").View[]} */
  const views = [
    { kind: "chat" },
    { kind: "file", path: "a" },
    { kind: "file", path: "b" },
    { kind: "file", path: "c" },
  ];

  assert.equal(closeFile(views, 3, 3).active, 2, "closing the last one steps back to its neighbour");
  assert.equal(closeFile(views, 1, 3).active, 1, "closing one behind does not move the reader");
  assert.equal(closeFile(views, 3, 1).active, 2, "closing one in front pulls the index down");
  assert.equal(closeFile(views, 1, 1).views.length, 3);

  const chat = closeFile(views, 0, 0);
  assert.equal(chat.views.length, 4, "the chat is the one view that cannot be closed");
  assert.equal(chat.active, 0);
});

test("file rows split a path and keep what was typed", () => {
  const rows = fileRows([{ path: "web/app.js" }, { path: "src/deep/app.js" }, { path: "README.md" }], "appj");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.name, "app.js");
    assert.ok(row.ranges.length > 0, "the typed letters are marked in the name");
    assert.ok(row.dir.length > 0, "and the folder is shown apart");
  }
});

test("an empty query keeps the order the server chose", () => {
  const rows = fileRows([{ path: "b.md" }, { path: "a.md" }], "");
  assert.deepEqual(
    rows.map((row) => row.path),
    ["b.md", "a.md"],
  );
});

test("a huge tree is cut short instead of painted whole", () => {
  const many = Array.from({ length: 900 }, (_, at) => ({ path: `f${at}.js` }));
  assert.equal(fileRows(many, "").length, 400);
});

test("lines are numbered and a trailing newline is not a line", () => {
  assert.deepEqual(numberLines("a\nb\n").lines, [
    { n: 1, value: "a" },
    { n: 2, value: "b" },
  ]);
  assert.equal(numberLines("a\nb\n").rest, 0);

  const capped = numberLines("a\nb\nc\n", 2);
  assert.equal(capped.lines.length, 2);
  assert.equal(capped.rest, 1);

  assert.deepEqual(numberLines("").lines, []);
});

test("a path is split into name and folder", () => {
  assert.equal(baseOf("src/deep/note.md"), "note.md");
  assert.equal(baseOf("note.md"), "note.md");
  assert.equal(dirOf("note.md"), "");
  assert.equal(dirOf("src/deep/note.md"), "src/deep");
});

test("a file and its patch are two views of one path", () => {
  const file = openFile(one, "notes.md");
  const patch = openDiff(file.views, "notes.md");
  assert.equal(patch.views.length, 3, "a patch is not the file, so it gets its own tab");
  assert.equal(patch.active, 2);

  const again = openDiff(patch.views, "notes.md");
  assert.equal(again.views.length, 3, "the same patch is focused rather than opened twice");
  assert.equal(again.active, 2);
});

test("status splits the way git tells it", () => {
  const files = [
    { path: "a", display: "a", status: "M", staged: true },
    { path: "b", display: "b", status: "M" },
    { path: "c", display: "c", status: "?", untracked: true },
  ];
  assert.deepEqual(
    statusGroups(files).map((group) => group.title),
    ["staged", "changes", "untracked"],
  );

  const single = statusGroups([{ path: "b", display: "b", status: "M" }]);
  assert.deepEqual(
    single.map((group) => group.title),
    [""],
    "one block needs no heading",
  );

  const against = statusGroups([
    { path: "b", display: "b", status: "M", staged: true },
    { path: "c", display: "c", status: "A", staged: true },
  ]);
  assert.deepEqual(
    against.map((group) => group.title),
    [""],
    "a base other than the worktree calls all of them staged, which says nothing",
  );
});

test("a glance takes the preview tab, a click on the tab keeps it", () => {
  const first = openFile(one, "a.js", true);
  assert.equal(first.views.length, 2);

  const second = openFile(first.views, "b.js", true);
  assert.equal(second.views.length, 2, "the next glance replaces the one before it");
  assert.equal(second.active, 1);

  const kept = pinView(second.views, 1);
  const pinned = /** @type {import("../panel.js").FileView} */ (kept.views[1]);
  assert.equal(pinned.preview, false);

  const third = openFile(kept.views, "c.js", true);
  assert.equal(third.views.length, 3, "with nothing on loan, a glance gets a tab of its own");

  const patch = openDiff(third.views, "c.js", false);
  assert.equal(patch.views.length, 4, "a file and the patch of it are still two things");
});

test("a folder shows what is directly in it", () => {
  const files = [{ path: "web/app.js" }, { path: "web/test/app.test.js" }, { path: "README.md" }];

  const root = fileTree(files, "");
  assert.deepEqual(
    root.dirs.map((dir) => [dir.name, dir.count]),
    [["web", 2]],
  );
  assert.deepEqual(
    root.files.map((file) => file.name),
    ["README.md"],
  );

  const deeper = fileTree(files, "web");
  assert.deepEqual(
    deeper.dirs.map((dir) => dir.path),
    ["web/test"],
  );
  assert.deepEqual(
    deeper.files.map((file) => file.path),
    ["web/app.js"],
  );

  assert.deepEqual(
    trailOf("web/test").map((step) => step.path),
    ["web", "web/test"],
    "every step of the trail is somewhere to go back to",
  );
});
