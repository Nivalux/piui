// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import { filterCommands, parseCommands } from "../commands.js";

const commands = [
  { name: "compact", description: "Summarize the conversation" },
  { name: "commit", description: "Stage and commit" },
  { name: "fix-tests", description: "Fix failing tests", argumentHint: "<warum>" },
  { name: "review-pr", description: "Review a pull request" },
  { name: "help", description: "List commands" },
];

test("a slash at the start opens the palette", () => {
  assert.deepEqual(parseCommands("/"), { query: "" });
  assert.deepEqual(parseCommands("/com"), { query: "com" });
});

test("an argument, a second line or plain prose close it", () => {
  assert.equal(parseCommands("/compact now"), null);
  assert.equal(parseCommands("before the slash /com"), null);
  assert.equal(parseCommands("/com\nmehr"), null);
  assert.equal(parseCommands(""), null);
});

test("prefix matches beat substring matches", () => {
  assert.deepEqual(
    filterCommands(commands, "co").map((command) => command.name),
    ["compact", "commit", "help"],
    "prefixes first, but a description mentioning it still counts",
  );
  assert.deepEqual(
    filterCommands(commands, "test").map((command) => command.name),
    ["fix-tests"],
    "a word boundary is closer than a mention in the description",
  );
  assert.deepEqual(
    filterCommands(commands, "summar").map((command) => command.name),
    ["compact"],
    "the description counts when the name does not",
  );
});

test("an empty query shows what pi offered, in its own order", () => {
  assert.equal(filterCommands(commands, "").length, 5);
  assert.equal(filterCommands([], "x").length, 0);
});
