// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import { builtins, filterCommands, knownCommands, parseCommands, parseSlash, slashRun } from "../commands.js";

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

test("pi's own commands are offered even though its pipe omits them", () => {
  const names = knownCommands([{ name: "pi-vcc", description: "Compact" }]).map((command) => command.name);
  assert.ok(names.includes("reload"), "reload is pi's, and pi does not report it");
  assert.ok(names.includes("settings"));
  assert.equal(names.filter((name) => name === "pi-vcc").length, 1);
});

test("a command pi reported stays pi's to run", () => {
  const merged = knownCommands([{ name: "compact", description: "my own compact" }]);
  assert.equal(merged.filter((command) => command.name === "compact").length, 1);
  assert.equal(merged.find((command) => command.name === "compact")?.description, "my own compact");
  assert.deepEqual(slashRun({ name: "pi-vcc", argument: "now" }, [{ name: "pi-vcc", description: "" }]), {
    name: "pi-vcc",
    run: "pi",
    argument: "now",
  });
});

test("an argument belongs to the command it follows", () => {
  assert.deepEqual(parseSlash("/model ollama/qwen"), { name: "model", argument: "ollama/qwen" });
  assert.deepEqual(parseSlash("  /compact   keep the tests  "), { name: "compact", argument: "keep the tests" });
  assert.deepEqual(parseSlash("/COPY"), { name: "copy", argument: "" });
  assert.equal(parseSlash("/"), null);
  assert.equal(parseSlash("run /new"), null);
  assert.equal(parseSlash("/new\nmore"), null);
});

test("a command this page cannot run is marked, and one nobody knows stays prose", () => {
  assert.equal(slashRun({ name: "settings", argument: "" }, [])?.run, "");
  assert.equal(slashRun({ name: "reload", argument: "" }, [])?.run, "reload");
  assert.equal(slashRun({ name: "nonsense", argument: "" }, []), null);
});

test("every command says what running it means", () => {
  for (const command of builtins) {
    assert.ok(command.name.length > 0 && (command.description ?? "").length > 0);
    assert.equal(typeof command.run, "string");
  }
});
