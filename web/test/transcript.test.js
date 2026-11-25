// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Transcript, toolRun } from "../transcript.js";

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
  transcript.event({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half" },
  });
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
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "file" }],
      isError: false,
    },
  ]);

  assert.deepEqual(
    transcript.blocks.map((block) => block.kind),
    ["user", "thinking", "text", "tool"],
  );
  assert.equal(
    transcript.blocks.every((block) => block.done),
    true,
  );
});

test("a compaction a chat came back with is still in it", () => {
  const transcript = new Transcript();

  transcript.replay([
    { role: "compactionSummary", summary: "Earlier: the wiring was read.", tokensBefore: 114904 },
    { role: "user", content: "and now the sidebar" },
  ]);

  assert.deepEqual(
    transcript.blocks.map((block) => block.kind),
    ["compaction", "user"],
    "the chat does not simply begin where the summary ends",
  );
  assert.equal(transcript.blocks[0].text, "114904 tokens compacted");
  assert.equal(transcript.blocks[0].summary, "Earlier: the wiring was read.");
});

test("a branch a chat came back on says where it came from", () => {
  const transcript = new Transcript();

  transcript.replay([{ role: "branchSummary", summary: "Copied from the wiring chat.", fromId: "e7" }]);

  assert.equal(transcript.blocks[0].kind, "compaction");
  assert.equal(transcript.blocks[0].text, "branch summary");
  assert.equal(transcript.blocks[0].summary, "Copied from the wiring chat.");
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
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c9", name: "read", arguments: { path: "/tmp/pick.png" } }],
    },
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

test("a tool that reports its own length is believed", () => {
  const transcript = new Transcript();

  transcript.event({ type: "message_start", message: { role: "assistant", content: [] } });
  transcript.event({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "make" } });
  transcript.event({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    durationMs: 9400,
    result: { content: [{ type: "text", text: "built" }] },
    isError: false,
  });

  const tool = transcript.blocks[0];
  assert.equal(tool.done, true);
  assert.equal(tool.durationMs, 9400, "the row shows the run, not the gap between two frames");
});

test("a tool does not finish before it started when the result lands late", () => {
  const transcript = new Transcript();

  transcript.event({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "make" } });
  transcript.event({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    durationMs: 4046,
    result: { content: [{ type: "text", text: "built" }] },
    isError: false,
  });

  // The stored toolResult stamps itself with the time pi wrote it, which is a
  // different clock from the moment the browser saw the tool start. Reading it
  // used to drag the finish back before the start, and the row lost its time
  // until the page was reloaded.
  transcript.event({
    type: "message_start",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      timestamp: new Date(Date.now() - 120000).toISOString(),
      content: [{ type: "text", text: "built" }],
    },
  });

  const tool = transcript.blocks[0];
  if (typeof tool.doneAt !== "number" || typeof tool.startedAt !== "number") {
    throw new Error("a finished tool carries both ends of its run");
  }
  assert.ok(tool.doneAt >= tool.startedAt, "the finish never walks back");
  assert.equal(toolRun(tool), 4046);
});

test("a restored tool keeps the length the session stored with the result", () => {
  const transcript = new Transcript();

  transcript.replay([
    {
      role: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } }],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      durationMs: 31000,
      timestamp: "2026-01-01T00:00:31.000Z",
      content: [{ type: "text", text: "built" }],
    },
  ]);

  assert.equal(toolRun(transcript.blocks[0]), 31000);
});

test("a tool seen only at its end has no length to show", () => {
  const transcript = new Transcript();

  transcript.event({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "built" }] },
    isError: false,
  });

  assert.equal(toolRun(transcript.blocks[0]), 0, "a run nobody watched is not measured by its tail");
});

test("a turn that stops on a thought leaves that thought as the reply", () => {
  const transcript = new Transcript();

  transcript.event({ type: "message_start", message: { role: "assistant", content: [] } });
  transcript.event({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "the answer is in here somewhere" },
  });
  transcript.event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "the answer is in here somewhere" }],
      stopReason: "stop",
    },
  });

  const [thought] = transcript.blocks;
  assert.equal(thought.kind, "thinking");
  assert.equal(thought.lastWord, true);
});

test("a thought with a reply after it stays a note above the answer", () => {
  const transcript = new Transcript();

  transcript.event({ type: "message_start", message: { role: "assistant", content: [] } });
  transcript.event({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm" },
  });
  transcript.event({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "here you go" },
  });
  transcript.event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "here you go" },
      ],
      stopReason: "stop",
    },
  });

  const [thought, answer] = transcript.blocks;
  assert.equal(thought.kind, "thinking");
  assert.equal(thought.lastWord, undefined);
  assert.equal(answer.kind, "text");
  assert.equal(answer.text, "here you go");
});

test("a restored chat knows which thought was the last word", () => {
  const transcript = new Transcript();
  transcript.replay([
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "that was the whole turn" }],
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
    },
  ]);

  assert.equal(transcript.blocks[0].lastWord, true);
});

test("a message that opened a text part and never filled it leaves nothing", () => {
  const transcript = new Transcript();
  transcript.event({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "run it" }] } });
  transcript.event({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "run it" }] } });
  transcript.event({ type: "message_start", message: { role: "assistant", content: [] } });
  transcript.event({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  transcript.event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "the calls said it all" }],
      stopReason: "toolUse",
    },
  });

  assert.deepEqual(
    transcript.blocks.map((block) => block.kind),
    ["user", "thinking"],
  );
});

test("a stored blank is dropped unless it carries the count of its turn", () => {
  const transcript = new Transcript();
  transcript.replay([
    { role: "assistant", content: [{ type: "text", text: "   " }], timestamp: 1_700_000_000_000 },
    {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      usage: { input: 3, output: 9 },
      timestamp: 1_700_000_001_000,
    },
  ]);

  assert.deepEqual(
    transcript.blocks.map((block) => block.kind),
    ["text"],
  );
  assert.equal(transcript.blocks[0].usage?.output, 9);
});

/**
 * @param {number} at
 * @param {number} input
 * @param {number} cacheRead
 * @returns {import("../protocol.js").Message}
 */
function priced(at, input, cacheRead) {
  return {
    role: /** @type {const} */ ("assistant"),
    content: [{ type: "text", text: "said" }],
    provider: "acme",
    model: "big",
    timestamp: at,
    usage: { input, output: 5, cacheRead, cacheWrite: 0, cost: {} },
  };
}

test("an answer whose prompt came back uncached says so beside the line that counts it", () => {
  const transcript = new Transcript();
  for (const message of [priced(1_700_000_000_000, 1000, 90_000), priced(1_700_000_060_000, 91_000, 0)]) {
    transcript.event({ type: "message_start", message: { role: "assistant", content: [] } });
    transcript.event({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "said" },
    });
    transcript.event({ type: "message_end", message });
  }

  const said = transcript.blocks.filter((block) => block.kind === "text");
  assert.equal(said.length, 2);
  assert.equal(said[0].cacheMiss, null);
  assert.equal(said[1].cacheMiss?.missedTokens, 91_000);
  assert.equal(transcript.waste.missCount, 1);
});

test("a stored chat counts its misses from where a compaction began", () => {
  const cached = priced(1_700_000_000_000, 1000, 90_000);
  const uncached = priced(1_700_000_060_000, 91_000, 0);

  const plain = new Transcript();
  plain.replay([cached, uncached]);
  assert.equal(plain.blocks[1].cacheMiss?.missedTokens, 91_000);

  const compacted = new Transcript();
  compacted.replay([cached, { role: "compactionSummary", summary: "kept", tokensBefore: 91_000 }, uncached]);
  assert.equal(compacted.blocks[2].cacheMiss, null);
  assert.equal(compacted.waste.missCount, 0);
});

test("a compaction that was called off leaves the comparison alone", () => {
  const transcript = new Transcript();
  transcript.event({ type: "message_end", message: priced(1_700_000_000_000, 1000, 90_000) });
  transcript.event({ type: "compaction_end", aborted: true, reason: "manual" });
  transcript.event({ type: "message_end", message: priced(1_700_000_060_000, 91_000, 0) });

  assert.equal(transcript.waste.missCount, 1);
});
