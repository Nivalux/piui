// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import { bestMatch, fuzzyMatch, rank } from "../filter.js";

test("letters in order match, letters out of order do not", () => {
  assert.ok(fuzzyMatch("scrol", "scroll to the end"));
  assert.equal(fuzzyMatch("lorsc", "scroll to the end"), null);
  assert.equal(fuzzyMatch("zz", "scroll to the end"), null);
});

test("a match is case insensitive and ignores surrounding space", () => {
  assert.ok(fuzzyMatch("DIFF", "show the diff panel"));
  assert.ok(fuzzyMatch("  diff  ", "show the diff panel"));
});

test("ranges cover runs as one span", () => {
  const hit = fuzzyMatch("bot", "scroll to the bottom");
  assert.ok(hit);
  assert.deepEqual(hit.ranges, [[14, 17]]);
});

test("word starts beat the middle of a word", () => {
  const words = fuzzyMatch("sb", "session bar");
  const middle = fuzzyMatch("sb", "usage box");
  assert.ok(words && middle);
  assert.ok(words.score > middle.score, `${words.score} > ${middle.score}`);
});

test("an exact substring beats a scattered match of the same letters", () => {
  const whole = fuzzyMatch("diff", "the diff panel");
  const apart = fuzzyMatch("diff", "duplicate default fields");
  assert.ok(whole && apart);
  assert.ok(whole.score > apart.score, `${whole.score} > ${apart.score}`);
});

test("a match at the front beats the same match late in a long title", () => {
  const early = fuzzyMatch("fix", "fix the failing tests");
  const late = fuzzyMatch("fix", "rework the harness and then fix the failing tests");
  assert.ok(early && late);
  assert.ok(early.score > late.score, `${early.score} > ${late.score}`);
});

test("bestMatch reports which field matched", () => {
  const best = bestMatch("srv", ["/srv/app", "chat"]);
  assert.ok(best);
  assert.equal(best.index, 0);

  const other = bestMatch("srv", ["chat", "/srv/app"]);
  assert.ok(other);
  assert.equal(other.index, 1);
  assert.deepEqual(other.ranges, [[1, 4]]);
});

test("a hit on a hidden field ranks but does not highlight", () => {
  const hits = rank("srv", [{ title: "chat", cwd: "/srv/app" }], (item) => [item.title, item.cwd]);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].ranges, []);
});

const sessions = [
  { title: "fix the failing tests", cwd: "/srv/app" },
  { title: "scroll behaviour", cwd: "/srv/web" },
  { title: "chat", cwd: "/srv/diff-tool" },
];

const texts = (/** @type {{title: string, cwd: string}} */ item) => [item.title, item.cwd];

test("an empty query keeps the incoming order", () => {
  assert.deepEqual(
    rank("", sessions, texts).map((hit) => hit.item.title),
    ["fix the failing tests", "scroll behaviour", "chat"],
  );
});

test("a query reaches the title and the folder", () => {
  assert.deepEqual(
    rank("diff", sessions, texts).map((hit) => hit.item.title),
    ["chat"],
  );
});

test("the best match comes first", () => {
  assert.deepEqual(
    rank("scr", sessions, texts).map((hit) => hit.item.title),
    ["scroll behaviour"],
  );
  assert.deepEqual(
    rank("f", sessions, texts).map((hit) => hit.item.title),
    ["fix the failing tests", "chat"],
  );
});

test("nothing typed matches nothing", () => {
  assert.deepEqual(rank("qqq", sessions, texts), []);
});
