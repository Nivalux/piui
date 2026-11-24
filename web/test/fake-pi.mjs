#!/usr/bin/env node
/**
 * Stands in for `pi --mode rpc` so the browser tests need no model, no key and no network. Speaks
 * the same line-delimited JSON on stdin and stdout.
 */
import fs from "node:fs";
import path from "node:path";
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

/** A real, tiny PNG, so a test can watch a picture arrive in a tool result. */
const shot = {
  id: "call_shot",
  name: "read",
  path: ".work/screenshot.png",
  data: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAUCAYAAADskT9PAAAANUlEQVR4nGN4kOP1Hx8WEZXCiynVzzDqgFEHjDqA1hYQ0j/qgFEHjDph4MuBUQeMOmCgHQAARi3M/RQC5ogAAAAASUVORK5CYII=",
};

const file = {
  id: "call_write",
  name: "write",
  path: "/tmp/piui-fake-write.txt",
  content: "alpha\nbeta\ngamma\n",
};

/**
 * What this session would hand back to `get_messages`. Pi replays the file it
 * was started with, so the stand-in does the same: a resumed chat would
 * otherwise open empty, and the client would have nothing to scroll to.
 *
 * @type {any[]}
 */
const history = replay(process.argv);

/** @type {{entryId: string, text: string}[]} */
const forks = history
  .filter((message) => message.role === "user")
  .map((message, index) => ({ entryId: `e${index + 1}`, text: textOf(message) }));

let forkSeq = forks.length;

/** @param {any} message */
function textOf(message) {
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** @param {string} text */
function asked(text) {
  const message = { role: "user", content: [{ type: "text", text }] };
  history.push(message);
  forks.push({ entryId: `e${++forkSeq}`, text });
  return message;
}

/**
 * @param {string[]} argv
 * @returns {any[]}
 */
function replay(argv) {
  const at = argv.indexOf("--session");
  const file = at >= 0 ? argv[at + 1] : "";
  if (!file || !fs.existsSync(file)) return [];

  /** @type {any[]} */
  const messages = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) messages.push(entry.message);
    } catch {
      // A line the stand-in cannot read is not a message worth replaying.
    }
  }
  return messages;
}

/**
 * What Pi holds between turns. `steer` lands after the current turn's tool
 * calls, `follow_up` once the answer is in, and `clear_queue` hands both back to
 * whoever sent them, which is what the page's "back to input" button is.
 *
 * @type {{steering: string[], followUp: string[]}}
 */
const queue = { steering: [], followUp: [] };
let steeringMode = "one-at-a-time";
let followUpMode = "one-at-a-time";

/** Whether a turn is in flight, which is what `get_state` reports. */
let isStreaming = false;

/** Every command this stand-in was sent, newest last, where a test can read it. */
const commandLog = process.env.PIUI_FAKE_COMMANDS;

/**
 * Say out loud what is waiting, the way Pi does on every change to the queue.
 */
function announceQueue() {
  send({ type: "queue_update", steering: [...queue.steering], followUp: [...queue.followUp] });
}

/**
 * A steer whose words reach neither a queue nor the chat, the way a pi that is
 * about to be replaced takes one and never says so.
 *
 * @param {string} text
 */
function swallowed(text) {
  return /unconfirmed/i.test(text);
}

/**
 * Hand the queued messages to the model: into the history and onto the stream,
 * so a client sees them leave the queue the way it sees a real Pi deliver them.
 *
 * @param {"steering" | "followUp"} kind
 */
function deliver(kind) {
  const texts = queue[kind];
  const stuck = /stuck/i.test(String(process.env.PIUI_FAKE_QUEUE ?? ""));
  queue[kind] = stuck ? [...texts] : [];
  announceQueue();
  for (const text of texts) {
    const message = asked(text);
    send({ type: "message_start", message, timestamp: now() });
    send({ type: "message_end", message, timestamp: now() });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => void answer(line.trim()));

/** @param {string} line */
async function answer(line) {
  /** @type {{type?: string, message?: string}} */
  /** @type {{type?: string, mode?: string, message?: string, entryId?: string}} */
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  if (commandLog) fs.appendFileSync(commandLog, `${line}\n`);

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

    case "switch_session":
      return send({
        type: "response",
        id: JSON.parse(line).id,
        command: "switch_session",
        success: true,
        data: { cancelled: true },
      });

    case "get_messages":
      return reply("get_messages", { messages: history });

    case "get_fork_messages":
      return reply("get_fork_messages", { messages: forks.map((item) => ({ ...item })) });

    case "fork": {
      const at = forks.findIndex((item) => item.entryId === command.entryId);
      if (at < 0) return reply("fork", { cancelled: true });
      const text = forks[at]?.text ?? "";

      let seen = 0;
      for (let index = 0; index < history.length; index += 1) {
        if (history[index]?.role !== "user") continue;
        if (seen === at) {
          history.length = index;
          break;
        }
        seen += 1;
      }
      forks.length = at;

      const again = asked(text);
      send({ type: "message_start", message: again, timestamp: now() });
      send({ type: "message_end", message: again, timestamp: now() });
      return reply("fork", { text, cancelled: false });
    }

    case "get_state":
      return reply("get_state", {
        isStreaming,
        steeringMode,
        followUpMode,
        pendingMessageCount: queue.steering.length + queue.followUp.length,
      });

    case "set_steering_mode":
      steeringMode = String(command.mode ?? "one-at-a-time");
      return reply("set_steering_mode", {});

    case "set_follow_up_mode":
      followUpMode = String(command.mode ?? "one-at-a-time");
      return reply("set_follow_up_mode", {});

    case "steer": {
      const text = String(command.message ?? "");
      if (!swallowed(text)) {
        queue.steering.push(text);
        announceQueue();
      }
      return reply("steer", { disposition: "queued" });
    }

    case "follow_up":
      queue.followUp.push(String(command.message ?? ""));
      announceQueue();
      return reply("follow_up", { disposition: "queued" });

    case "clear_queue": {
      const held = { steering: queue.steering, followUp: queue.followUp };
      queue.steering = [];
      queue.followUp = [];
      announceQueue();
      return reply("clear_queue", held);
    }

    case "prompt":
      asked(String(command.message ?? ""));
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
  // A prompt that says `scrawl` changes a tracked file in the chat's folder, so
  // a test can watch the diff panel notice a change on its own.
  const scrawl = /scrawl/i.test(prompt);

  send({ type: "agent_start", timestamp: now() });
  send({ type: "turn_start", timestamp: now() });
  isStreaming = true;

  const opening = { role: "user", content: [{ type: "text", text: prompt }] };
  send({ type: "message_start", message: opening, timestamp: now() });
  send({ type: "message_end", message: opening, timestamp: now() });

  send({ type: "message_start", message: { role: "assistant" }, timestamp: now() });

  if (/dumbstruck/i.test(prompt)) return dumbstruck();

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

  if (/hold the run/i.test(prompt)) {
    await sleep(1200);
    deliver("steering");
    return streamAnswer();
  }

  if (/endless stream/i.test(prompt)) {
    await sleep(400);
    return endless();
  }

  if (tall) return tallAnswer();

  // Two seconds of tokens, so a test can watch what a page does to the rest of
  // itself while an answer is arriving.
  if (/stream/i.test(prompt)) return streamAnswer();

  if (long) {
    await shell(slow, "later\n");
    deliver("steering");
    return answer2();
  }

  await shell(bash, "done\n");
  deliver("steering");

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
    durationMs: 4200,
    result: { content: [{ type: "text", text: `wrote ${file.path}` }] },
    isError: false,
    timestamp: now(),
  });

  send({
    type: "tool_execution_start",
    toolCallId: shot.id,
    toolName: shot.name,
    args: { path: shot.path },
    timestamp: now(),
  });
  await sleep(60);
  send({
    type: "tool_execution_end",
    toolCallId: shot.id,
    toolName: shot.name,
    durationMs: 2600,
    result: {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", mimeType: "image/png", data: shot.data },
      ],
    },
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
    durationMs: 1900,
    result: { content: [{ type: "text", text: "ENOENT: no such file or directory, open '/nope/missing.txt'" }] },
    isError: true,
    timestamp: now(),
  });

  if (scrawl) fs.appendFileSync(path.join(process.cwd(), "log.txt"), "scrawled by the fake pi\n");

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
 * An answer that keeps arriving for about two seconds.
 */
async function endless() {
  let text = "";
  const pace = Number(process.env.PIUI_FAKE_PACE ?? 10);
  const lines = Number(process.env.PIUI_FAKE_LINES ?? 450);

  send({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    timestamp: now(),
  });
  for (let line = 1; line <= lines; line += 1) {
    const delta = `wort ${line} `;
    text += delta;
    send({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
      timestamp: now(),
    });
    await sleep(pace);
  }
  send({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 }, timestamp: now() });

  send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 }, timestamp: now() });
  for (let line = 1; line <= lines; line += 1) {
    const delta = line % 40 === 0 ? "\n\n```zig\nconst width = 40;\n```\n\n" : `wort ${line} `;
    text += delta;
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      timestamp: now(),
    });
    await sleep(pace);
  }
  send({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 }, timestamp: now() });
  return text;
}

async function streamAnswer() {
  let text = "";
  for (let line = 1; line <= 80; line += 1) {
    const delta = `token ${line} `;
    text += delta;
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      usage: { input: 10, output: line, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      timestamp: now(),
    });
    await sleep(25);
  }

  history.push({ role: "assistant", content: [{ type: "text", text }] });
  send({ type: "message_end", message: { role: "assistant" }, timestamp: now() });
  deliver("steering");
  send({ type: "turn_end", timestamp: now() });
  send({ type: "agent_end", willRetry: false, timestamp: now() });
  settle();
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
  settle();
}

/**
 * A turn that stops on a thought. The model thinks and has stopReason "stop"
 * with nothing to show for it: what is left for the reader is the thought.
 */
async function dumbstruck() {
  let thinking = "";
  for (const part of ["The answer is already ", "in here, but the model ", "never says it. "]) {
    thinking += part;
    send({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: part },
      timestamp: now(),
    });
    await sleep(60);
  }

  const message = { role: "assistant", content: [{ type: "thinking", thinking }], stopReason: "stop" };
  history.push(message);
  send({ type: "message_end", message, timestamp: now() });
  send({ type: "turn_end", timestamp: now() });
  send({ type: "agent_end", willRetry: false, timestamp: now() });
  settle();
}

async function answer2() {
  deliver("followUp");
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
  settle();
}

/** Close the run out, so `get_state` stops saying a turn is in flight. */
function settle() {
  isStreaming = false;
  send({ type: "agent_settled", timestamp: now() });
}
