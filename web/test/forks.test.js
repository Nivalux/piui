// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import { lineage } from "../forks.js";

const root = "/home/pi/.pi/agent/sessions/--cache-projects-piui--";

/**
 * @param {Partial<import("../forks.js").Chat>} over
 * @returns {import("../forks.js").Chat}
 */
function chat(over) {
  return {
    id: "aaaa",
    path: `${root}/2026-11-19T19-35-00-504Z_aaaa.jsonl`,
    title: "design a web front end",
    ...over,
  };
}

const parent = chat({});
const first = chat({
  id: "bbbb",
  path: `${root}/2026-11-23T16-34-42-747Z_bbbb.jsonl`,
  parent: parent.path,
  created: "2026-11-23T16:34:42.747Z",
});
const second = chat({
  id: "cccc",
  path: `${root}/2026-11-23T16-35-52-547Z_cccc.jsonl`,
  parent: parent.path,
  created: "2026-11-23T16:35:52.547Z",
});

test("the forks of one chat are numbered in the order they were made", () => {
  const found = lineage([second, first, parent]);

  assert.equal(found.get(second.path)?.mark, "#2");
  assert.equal(found.get(first.path)?.mark, "#1");
  assert.equal(found.get(parent.path), undefined, "the chat they came from is not itself a fork");
});

test("a fork names the chat it came from", () => {
  const found = lineage([first, parent]);

  assert.equal(found.get(first.path)?.of, "design a web front end");
  assert.equal(found.get(first.path)?.mark, "", "one fork of a chat has nothing to number");
});

test("a fork whose parent is gone says so by the id it remembers", () => {
  const orphan = chat({
    id: "dddd",
    path: `${root}/2026-11-23T16-40-00-000Z_dddd.jsonl`,
    parent: `${root}/2026-11-01T10-00-00-000Z_01a1f54e2098.jsonl`,
  });

  const found = lineage([orphan]);

  assert.equal(found.get(orphan.path)?.of, "gone chat 01a1f54e");
  assert.equal(found.get(orphan.path)?.mark, "");
});

test("forks of different chats keep their own numbers", () => {
  const other = chat({
    id: "eeee",
    path: `${root}/2026-11-18T08-00-00-000Z_eeee.jsonl`,
    title: "another chat entirely",
  });
  const underOther = chat({
    id: "ffff",
    path: `${root}/2026-11-23T17-00-00-000Z_ffff.jsonl`,
    parent: other.path,
    created: "2026-11-23T17:00:00.000Z",
  });

  const found = lineage([second, first, parent, underOther, other]);

  assert.equal(found.get(underOther.path)?.mark, "");
  assert.equal(found.get(underOther.path)?.of, "another chat entirely");
  assert.equal(found.get(first.path)?.mark, "#1");
});
