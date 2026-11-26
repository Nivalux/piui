// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ago,
  basename,
  bytes,
  contextRing,
  cost,
  duration,
  firstLine,
  hintParts,
  perSecond,
  preview,
  projectPath,
  relativeTime,
  shortPath,
  badge,
  time,
  tokens,
  toolSummary,
  truncate,
} from "../format.js";

test("counts read as counts, not as raw digits", () => {
  assert.equal(tokens(999), "999");
  assert.equal(tokens(1200), "1.2k");
  assert.equal(tokens(1_400_000), "1.4M");
});

test("money stops being precise once it is real", () => {
  assert.equal(cost(0.0041), "$0.0041");
  assert.equal(cost(2.4567), "$2.46");
});

test("the rate is precise while it is small", () => {
  assert.equal(perSecond(4.25), "4.3 t/s");
  assert.equal(perSecond(37.44), "37 t/s");
  assert.equal(perSecond(0), "— t/s");
});

test("durations say only as much as they know", () => {
  assert.equal(duration(900), "900ms");
  assert.equal(duration(9_000), "9.0s");
  assert.equal(duration(65_000), "1m 05s");
});

test("a tool gets a headline out of whatever it was handed", () => {
  assert.equal(toolSummary("read", { path: "/src/main.zig" }), "/src/main.zig");
  assert.equal(toolSummary("bash", { command: "just test 2>&1 | head" }), "just test 2>&1 | head");
  assert.equal(toolSummary("edit", { path: "a.go", edits: [{ oldText: "x" }, { oldText: "y" }] }), "a.go · 2 edits");
  assert.equal(toolSummary("grep", { pattern: "pub fn", path: "src" }), "pub fn", "searching beats the directory");
  assert.equal(toolSummary("unknown", { anything: 4 }), "anything: 4");
  assert.equal(toolSummary("unknown", undefined), "unknown");
});

test("a path the chat is working in is told from the chat", () => {
  assert.equal(projectPath("/work/app/src/main.zig", "/work/app"), "./src/main.zig");
  assert.equal(projectPath("/work/app/src/main.zig", "/work/app/"), "./src/main.zig");
  assert.equal(projectPath("/work/apple/main.zig", "/work/app"), "/work/apple/main.zig");
  assert.equal(projectPath("/work/app", "/work/app"), "/work/app");
  assert.equal(projectPath("/work/app/main.zig", ""), "/work/app/main.zig");
  assert.equal(toolSummary("read", { path: "/work/app/main.zig" }, "/work/app"), "./main.zig");
  assert.equal(
    toolSummary("edit", { path: "/work/app/a.go", edits: [{ oldText: "x" }, { oldText: "y" }] }, "/work/app"),
    "./a.go · 2 edits",
  );
  assert.equal(toolSummary("read", { path: "/other/main.zig" }, "/work/app"), "/other/main.zig");
});

test("paths shorten from the left, so the tail stays readable", () => {
  assert.equal(basename("/home/dev/projekt"), "projekt");
  assert.equal(basename("projekt"), "projekt");
  assert.equal(basename(""), "");
});

test("a preview keeps whole lines and says when it cut", () => {
  assert.equal(preview("brief", 2), "brief");
  assert.equal(preview("a\nb\nc", 2), "a\nb\n…");
});

test("sizes read like a file listing", () => {
  assert.equal(bytes(0), "0 B");
  assert.equal(bytes(512), "512 B");
  assert.equal(bytes(2048), "2.0 kB");
  assert.equal(bytes(3 * 1024 * 1024), "3.0 MB");
});

test("a one-liner ends with an ellipsis, not a scrollbar", () => {
  assert.equal(truncate("x".repeat(30), 10), `${"x".repeat(10)}…`);
  assert.equal(firstLine("\n  the real line  \n"), "the real line");
});

test("timestamps answer the question the sidebar is asked", () => {
  const now = Date.UTC(2026, 1, 10, 12, 0, 0);
  assert.equal(relativeTime(new Date(now - 30_000).toISOString(), now), "now");
  assert.equal(relativeTime(new Date(now - 5 * 60_000).toISOString(), now), "5m ago");
  assert.equal(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now), "3h ago");
  assert.equal(relativeTime(null, now), "—");
  assert.equal(time(new Date(2026, 1, 10, 12, 0, 0).toISOString()), "12:00:00");
});

test("a folder path keeps the part you recognise", () => {
  assert.equal(shortPath("/cache/projects/piui"), "…/projects/piui");
  assert.equal(shortPath("/cache/piui"), "/cache/piui");
  assert.equal(shortPath("piui"), "piui");
  assert.equal(shortPath("///"), "///");
});

test("a duration fits one word when it labels a row", () => {
  assert.equal(ago(900), "0s");
  assert.equal(ago(45_000), "45s");
  assert.equal(ago(90_000), "1m");
  assert.equal(ago(35 * 60_000), "35m");
  assert.equal(ago(3 * 3_600_000), "3h");
  assert.equal(ago(50 * 3_600_000), "2d");
  assert.equal(ago(-1), "—");
});

test("a badge is two letters, or a dot pair when there is no folder", () => {
  assert.equal(badge("/cache/projects/piui"), "PI");
  assert.equal(badge("/srv/my-config"), "MY");
  assert.equal(badge("/srv/---"), "··");
  assert.equal(badge("/cache/projects/.piui/scratch/12ab", false), "··");
});

test("a hint colours only the added and removed counts", () => {
  assert.deepEqual(hintParts("+4 −0"), [
    { text: "+4", kind: "add" },
    { text: " ", kind: "" },
    { text: "−0", kind: "del" },
  ]);
  assert.deepEqual(hintParts("4 lines"), [{ text: "4 lines", kind: "" }]);
  assert.deepEqual(hintParts(""), []);
});

test("a context ring says the share, the numbers and the worry", () => {
  assert.deepEqual(contextRing(60000, 200000), {
    fraction: 0.3,
    percent: 30,
    label: "60k / 200k",
    tone: "",
  });
});

test("a ring stays quiet without both numbers", () => {
  const quiet = { fraction: 0, percent: 0, label: "", tone: "" };
  assert.deepEqual(contextRing(null, 200000), quiet);
  assert.deepEqual(contextRing(60000, null), quiet);
  assert.deepEqual(contextRing(60000, 0), quiet);
  assert.deepEqual(contextRing(-1, 200000), quiet);
});

test("a full window is a full ring, never more", () => {
  assert.deepEqual(contextRing(300000, 200000), {
    fraction: 1,
    percent: 100,
    label: "300k / 200k",
    tone: "critical",
  });
});

test("a ring warms before it turns red", () => {
  assert.equal(contextRing(140000, 200000).tone, "warm");
  assert.equal(contextRing(178000, 200000).tone, "warm");
  assert.equal(contextRing(180000, 200000).tone, "critical");
  assert.equal(contextRing(1000, 200000).tone, "");
});
