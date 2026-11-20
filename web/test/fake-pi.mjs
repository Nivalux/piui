#!/usr/bin/env node
/**
 * Stands in for `pi --mode rpc` so the browser tests need no model, no key and
 * no network. Speaks the same line-delimited JSON on stdin and stdout.
 *
 * Two turns are scripted. The plain one replays thinking, a bash call that
 * streams while it runs, a write, a failing read and a markdown answer. Ask for
 * "the long one" and only a slow bash call runs, so a test can open a call that
 * is genuinely still going.
 */
import readline from "node:readline";

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

const bash = {
  id: "call_bash",
  name: "bash",
  command: "sleep 2 && echo done",
  runsMs: Number(process.env.PIUI_FAKE_BASH_MS ?? 2200),
  ticks: 4,
};

const slow = {
  id: "call_slow",
  name: "bash",
  command: "sleep 6 && echo later",
  runsMs: Number(process.env.PIUI_FAKE_SLOW_MS ?? 6000),
  ticks: 6,
};

const file = {
  id: "call_write",
  name: "write",
  path: "/tmp/piui-fake-write.txt",
  content: "alpha\nbeta\ngamma\n",
};

/**
 * What this session would hand back to `get_messages`. A reopened chat is
 * empty without it, and the client then has nothing to scroll to.
 *
 * @type {any[]}
 */
const history = [];

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => void answer(line.trim()));

/** @param {string} line */
async function answer(line) {
  /** @type {{type?: string, message?: string}} */
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  switch (command.type) {
    case "get_available_models":
      return reply("get_available_models", {
        models: [
          {
            id: "fake-model",
            name: "Fake Model",
            provider: "fake",
            contextWindow: 200000,
            maxTokens: 8192,
            reasoning: true,
          },
        ],
      });

    case "get_available_thinking_levels":
      return reply("get_available_thinking_levels", { levels: ["off", "low", "medium", "high"] });

    case "get_session_stats": {
      const tokens = contextUsed();
      return reply("get_session_stats", {
        tokens: { input: 120, output: 34, cacheRead: 900, cacheWrite: 0, total: 1054 },
        cost: 0.01,
        contextUsage: {
          tokens,
          contextWindow: 200000,
          percent: tokens === null ? null : (tokens / 200000) * 100,
        },
      });
    }

    case "get_entries":
      return reply("get_entries", { entries: [] });

    case "get_messages":
      return reply("get_messages", { messages: history });

    case "prompt":
      history.push({ role: "user", content: [{ type: "text", text: command.message ?? "" }] });
      send({ type: "response", command: "prompt", success: true, data: {} });
      return turn(command.message ?? "");

    default:
      return reply(String(command.type ?? "unknown"), {});
  }
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} data
 */
function reply(command, data) {
  send({ type: "response", command, success: true, data });
}

/**
 * How full the window is, in tokens. A prompt that says `widen` stands for a
 * turn that changes it, so a test can watch the meter follow: the second one is
 * a compaction, and Pi has no count of its own to give until the answer after
 * that one is in.
 */
let widened = 0;

function contextUsed() {
  if (widened === 0) return 61000;
  if (widened === 1) return 141000;
  if (widened === 2) return null;
  return 41000;
}

/** @param {string} prompt */
async function turn(prompt) {
  const long = /long/i.test(prompt);
  const tall = /tall/i.test(prompt);
  const thoughtful = /thoughtful/i.test(prompt);
  if (/widen/i.test(prompt)) widened += 1;

  send({ type: "agent_start", timestamp: now() });
  send({ type: "turn_start", timestamp: now() });
  send({ type: "message_start", message: { role: "assistant" }, timestamp: now() });

  const parts = thoughtful
    ? ["Weighing ", "up the ", "trade-offs ", "of every ", "possible ", "shape ", "of this ", "answer. "]
    : ["Planning ", "the two ", "tool calls. "];

  for (const part of parts) {
    send({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: part },
      timestamp: now(),
    });
    await sleep(thoughtful ? 260 : 30);
  }

  if (tall) return tallAnswer();

  if (long) {
    await shell(slow, "later\n");
    return answer2();
  }

  await shell(bash, "done\n");

  send({
    type: "tool_execution_start",
    toolCallId: file.id,
    toolName: file.name,
    args: { path: file.path, content: file.content },
    timestamp: now(),
  });
  await sleep(120);
  send({
    type: "tool_execution_end",
    toolCallId: file.id,
    toolName: file.name,
    result: { content: [{ type: "text", text: `wrote ${file.path}` }] },
    isError: false,
    timestamp: now(),
  });

  send({
    type: "tool_execution_start",
    toolCallId: "call_fail",
    toolName: "read",
    args: { path: "/nope/missing.txt" },
    timestamp: now(),
  });
  await sleep(80);
  send({
    type: "tool_execution_end",
    toolCallId: "call_fail",
    toolName: "read",
    result: { content: [{ type: "text", text: "ENOENT: no such file or directory, open '/nope/missing.txt'" }] },
    isError: true,
    timestamp: now(),
  });

  return answer2();
}

/**
 * One bash call, streaming what it has printed so far. A partial result is the
 * whole output up to now, not the newest line.
 *
 * @param {{id: string, name: string, command: string, runsMs: number, ticks: number}} call
 * @param {string} final
 */
async function shell(call, final) {
  send({
    type: "tool_execution_start",
    toolCallId: call.id,
    toolName: call.name,
    args: { command: call.command, timeout: 600 },
    timestamp: now(),
  });

  let streamed = "";
  for (let tick = 1; tick <= call.ticks; tick += 1) {
    await sleep(call.runsMs / call.ticks);
    streamed += `tick ${tick}\n`;
    send({
      type: "tool_execution_update",
      toolCallId: call.id,
      partialResult: { content: [{ type: "text", text: streamed }] },
      timestamp: now(),
    });
  }

  send({
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    result: { content: [{ type: "text", text: final }] },
    isError: false,
    timestamp: now(),
  });
}

/**
 * An answer long enough on its own that the transcript has to scroll.
 */
async function tallAnswer() {
  let text = "";
  for (let line = 1; line <= 26; line += 1) {
    const delta = `Zeile ${line}: Der Modelltext ist lang genug, damit der Chat uber den Rand wachst.\n\n`;
    text += delta;
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      usage: { input: 120, output: 34, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } },
      timestamp: now(),
    });
    await sleep(10);
  }

  history.push({ role: "assistant", content: [{ type: "text", text }] });
  send({ type: "message_end", message: { role: "assistant" }, timestamp: now() });
  send({ type: "turn_end", timestamp: now() });
  send({ type: "agent_end", willRetry: false, timestamp: now() });
  send({ type: "agent_settled", timestamp: now() });
}

async function answer2() {
  let text = "";
  for (const part of [
    "**Beide Tools** sind durch.\n\n",
    "- write: `piui-fake-write.txt`\n",
    "- read: fehlgeschlagen\n",
  ]) {
    text += part;
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: part },
      usage: { input: 120, output: 34, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } },
      timestamp: now(),
    });
    await sleep(30);
  }

  history.push({ role: "assistant", content: [{ type: "text", text }] });
  send({ type: "message_end", message: { role: "assistant" }, timestamp: now() });
  send({ type: "turn_end", timestamp: now() });
  send({ type: "agent_end", willRetry: false, timestamp: now() });
  send({ type: "agent_settled", timestamp: now() });
}
