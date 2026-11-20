// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Transcript } from "../transcript.js";

/** @param {string} name */
function fixture(name) {
  return new URL(`../../testdata/${name}`, import.meta.url);
}

/** @param {string | URL} path */
function records(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test("a real event stream folds into one transcript", () => {
  const transcript = new Transcript();
  for (const record of records(fixture("stream.jsonl"))) transcript.event(record);

  const kinds = transcript.blocks.map((block) => block.kind);
  assert.deepEqual(kinds, ["user", "thinking", "text", "tool"]);

  const [user, thinking, text, tool] = transcript.blocks;
  assert.equal(user.text, "why is the framing test red?");
  assert.equal(thinking.text, "the reader drops the last record");
  assert.equal(text.text, "Reading the tail.");
  assert.equal(tool.toolName, "bash");
  assert.equal(tool.done, true);
  assert.equal(tool.isError, false);
  assert.equal(transcript.running, false);
});

test("the final message wins over the deltas", () => {
  const transcript = new Transcript();

  transcript.event({ type: "message_start", message: { role: "assistant", content: [] } });
  transcript.event({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Read" },
  });
  assert.equal(transcript.blocks[0].text, "Read");

  transcript.event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Reading the tail of the file." }],
      usage: { input: 10, output: 4, totalTokens: 14 },
      stopReason: "stop",
    },
  });

  assert.equal(transcript.blocks.length, 1, "the streamed block is finished, not duplicated");
  assert.equal(transcript.blocks[0].text, "Reading the tail of the file.");
  assert.equal(transcript.blocks[0].usage?.output, 4);
  assert.equal(transcript.blocks[0].stopReason, "stop");
});

test("a call is titled by its arguments from the moment it starts", () => {
  const transcript = new Transcript();
  transcript.event({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "bash",
    args: { command: "sleep 6 && echo later" },
  });

  assert.equal(transcript.blocks[0].done, false);
  assert.equal(transcript.blocks[0].title, "sleep 6 && echo later");
});

test("a tool call announced twice stays one block", () => {
  const transcript = new Transcript();

  transcript.event({
    type: "message_start",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/x" } }],
    },
  });
  transcript.event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/tmp/x" } });
  transcript.event({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "read",
    partialResult: { content: [{ type: "text", text: "half" }] },
  });
  transcript.event({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "all of it" }] },
    isError: false,
  });

  const tools = transcript.blocks.filter((block) => block.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].done, true);
  assert.deepEqual(tools[0].result, { content: [{ type: "text", text: "all of it" }] });
});

test("images stay attached to the message that carried them", () => {
  const transcript = new Transcript();

  transcript.event({
    type: "message_start",
    message: {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    },
  });

  assert.equal(transcript.blocks[0].images?.length, 1);
  assert.equal(transcript.blocks[0].images?.[0].mimeType, "image/png");
});

test("a bang line is a shell run, not a prompt", () => {
  const transcript = new Transcript();
  transcript.event({ type: "message_start", message: { role: "user", content: "!just test" } });

  assert.equal(transcript.blocks[0].kind, "bash");
  assert.equal(transcript.blocks[0].text, "just test");
});

test("retry and compaction leave a trace", () => {
  const transcript = new Transcript();

  transcript.event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529" });
  transcript.event({
    type: "compaction_end",
    reason: "threshold",
    result: { summary: "compacted", tokensBefore: 150000 },
    aborted: false,
  });

  assert.equal(transcript.blocks[0].kind, "status");
  assert.match(String(transcript.blocks[0].text), /attempt 1\/3/);
  assert.equal(transcript.blocks[1].kind, "compaction");
  assert.equal(transcript.blocks[1].summary, "compacted");
});

test("a run that ended while the page was away still closes", () => {
  const transcript = new Transcript();

  transcript.event({ type: "agent_start" });
  transcript.event({ type: "message_start", message: { role: "assistant", content: [] } });
  transcript.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half" } });
  assert.equal(transcript.blocks[0].done, false);

  transcript.event({ type: "agent_settled" });
  assert.equal(transcript.blocks[0].done, true);
  assert.equal(transcript.running, false);
});

test("replaying stored messages needs no events at all", () => {
  const transcript = new Transcript();

  transcript.replay([
    { role: "user", content: "erster text" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "kurz" },
        { type: "text", text: "antwort" },
      ],
      usage: { input: 3, output: 2 },
    },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "file" }], isError: false },
  ]);

  assert.deepEqual(
    transcript.blocks.map((block) => block.kind),
    ["user", "thinking", "text", "tool"],
  );
  assert.equal(transcript.blocks.every((block) => block.done), true);
});

test("tool details survive the live event and the replay", () => {
  const live = new Transcript();
  live.event({ type: "tool_execution_start", toolCallId: "c1", toolName: "edit", args: { path: "/tmp/a" } });
  live.event({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "edit",
    result: [{ type: "text", text: "replaced 1 block" }],
    isError: false,
    details: { patch: "@@ -1 +1 @@", firstChangedLine: 1 },
  });

  const [block] = live.blocks;
  assert.equal(block.kind, "tool");
  assert.deepEqual(block.details, { patch: "@@ -1 +1 @@", firstChangedLine: 1 });

  const replayed = new Transcript();
  replayed.replay([
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "/tmp/a" } }] },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "edit",
      content: [{ type: "text", text: "replaced 1 block" }],
      details: { patch: "@@ -1 +1 @@", firstChangedLine: 1 },
    },
  ]);

  assert.deepEqual(replayed.blocks[0].details, { patch: "@@ -1 +1 @@", firstChangedLine: 1 });
});

test("a picture a tool read stays a picture", () => {
  const live = new Transcript();
  live.event({ type: "tool_execution_start", toolCallId: "c9", toolName: "read", args: { path: "/tmp/pick.png" } });
  live.event({
    type: "tool_execution_end",
    toolCallId: "c9",
    toolName: "read",
    result: {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    },
    isError: false,
  });

  assert.deepEqual(live.blocks[0].images, [{ mimeType: "image/png", data: "aGVsbG8=" }]);

  const replayed = new Transcript();
  replayed.replay([
    { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "read", arguments: { path: "/tmp/pick.png" } }] },
    {
      role: "toolResult",
      toolCallId: "c9",
      toolName: "read",
      content: [{ type: "image", mimeType: "image/jpeg", data: "aGk=" }],
    },
  ]);

  assert.deepEqual(replayed.blocks[0].images, [{ mimeType: "image/jpeg", data: "aGk=" }]);
});

test("a replayed tool keeps how long it took", () => {
  const transcript = new Transcript();

  transcript.replay([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } }],
      timestamp: 1_700_000_000_000,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "done" }],
      timestamp: 1_700_000_009_000,
    },
  ]);

  const [block] = transcript.blocks;
  assert.equal(block.doneAt !== undefined && block.doneAt - (block.startedAt ?? 0), 9_000);
});

test("a chat that is still working replays with its tool still open", () => {
  /** @type {import("../protocol.js").Message[]} */ const messages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } }],
      timestamp: 1_700_000_000_000,
    },
  ];

  const running = new Transcript();
  running.replay(messages, true);
  assert.equal(running.blocks[0].done, false, "the bash is still running");
  assert.equal(running.running, true);
  assert.equal(running.blocks[0].startedAt, 1_700_000_000_000, "and its clock knows when it began");

  const settled = new Transcript();
  settled.replay(messages, false);
  assert.equal(settled.blocks[0].done, true, "a chat at rest has no open tool");
});
