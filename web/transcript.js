// @ts-check

/**
 * The transcript, folded from pi's events.
 *
 * - `{kind:"user", text, images}`
 * - `{kind:"thinking", text, done}`
 * - `{kind:"text", text, done, usage, stopReason}`
 * - `{kind:"tool", toolCallId, toolName, title, args, result, progress, isError, done}`
 * - `{kind:"bash", text, done}` output of a `!` shell line
 * - `{kind:"compaction", text, summary}`
 * - `{kind:"status", level, text}` piui's own notes
 * - `{kind:"error", text}`
 */

import { CacheWatch, notice } from "./cache.js";
import { toolSummary } from "./format.js";
import { blocks, imagesOf } from "./protocol.js";

/**
 * @typedef {import("./protocol.js").Frame} Frame
 * @typedef {import("./protocol.js").Message} Message
 * @typedef {import("./protocol.js").Content} Content
 * @typedef {import("./protocol.js").Usage} Usage
 * @typedef {import("./protocol.js").AssistantEvent} AssistantEvent
 * @typedef {{mimeType: string, data: string}} Image
 *
 * @typedef {Object} Block
 * @property {"user" | "thinking" | "text" | "tool" | "bash" | "compaction" | "status" | "error"}
 * kind
 * @property {number} id
 * @property {string} [text]
 * @property {boolean} [done]
 * @property {Image[]} [images]
 * @property {Usage | null} [usage]
 * @property {string | null} [stopReason]
 * @property {string | null} [error]
 * @property {string} [toolCallId]
 * @property {string} [toolName]
 * @property {string} [title]
 * @property {Record<string, unknown> | null} [args]
 * @property {string} [argsText]
 * @property {unknown} [result]
 * @property {unknown} [details]
 * @property {unknown} [progress]
 * @property {boolean} [isError]
 * @property {"info" | "retry" | "error"} [level]
 * @property {string | null} [summary]
 * @property {number} [startedAt]
 * @property {number} [doneAt]
 * @property {number} [durationMs] how long the tool says it ran
 * @property {boolean} [lastWord] a thought the turn stopped on, with no reply after it
 * @property {import("./cache.js").Miss | null} [cacheMiss] what this answer paid for a prompt the cache let go
 * @property {Usage | null} [request] the one request that produced this fold
 * @property {Tally | null} [turn] everything the question cost, over every request it took
 */

/**
 * @typedef {Object} Tally
 * @property {number} requests
 * @property {number} input
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} output
 * @property {number} cost
 * @property {number} missed
 * @property {number} missedCost
 */

function blankTally() {
  return { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, missed: 0, missedCost: 0 };
}

let nextId = 0;

/**
 * How long a finished tool ran, in milliseconds, or 0 when nothing honest is known.
 *
 * @param {Block} block
 */
export function toolRun(block) {
  const stamps =
    block.doneAt !== undefined && block.startedAt !== undefined ? Math.max(block.doneAt - block.startedAt, 0) : 0;
  return Math.max(block.durationMs ?? 0, stamps);
}

export class Transcript {
  /** @type {Block[]} */
  #blocks = [];
  /** @type {Map<string, Block>} tool call id → block */
  #tools = new Map();
  /** @type {Map<string, Block>} bash command id → block */
  #shells = new Map();

  /** @type {{text: Block[], thinking: Block[]}} the message currently streamed */
  #current = { text: [], thinking: [] };

  #running = false;
  #turn = 0;
  /** @type {Usage | null} */
  #usage = null;
  /** @type {Message[]} */
  #queue = [];
  #cache = new CacheWatch();
  /** @type {Tally} */
  #tally = blankTally();
  /** @type {Block | null} */
  #lastAnswer = null;

  /** @returns {Block[]} */
  get blocks() {
    return this.#blocks;
  }

  /** @returns {boolean} */
  get running() {
    return this.#running;
  }

  /** @returns {number} */
  get turn() {
    return this.#turn;
  }

  /** @returns {Usage | null} */
  get usage() {
    return this.#usage;
  }

  /** @returns {Message[]} */
  get queue() {
    return this.#queue;
  }

  /** @returns {import("./cache.js").Waste} everything re-billed past the cache since this chat was read */
  get waste() {
    return this.#cache.waste;
  }

  clear() {
    this.#blocks = [];
    this.#running = false;
    this.#tools.clear();
    this.#shells.clear();
    this.#current = { text: [], thinking: [] };
    this.#usage = null;
    this.#queue = [];
    this.#cache = new CacheWatch();
    this.#tally = blankTally();
    this.#lastAnswer = null;
  }

  /**
   * A stored transcript, from the `get_messages` response.
   *
   * @param {Message[]} messages
   * @param {boolean} [running]
   */
  replay(messages, running = false) {
    this.clear();
    for (const message of messages) this.#message(message, true);
    if (running) {
      this.#running = true;
      return;
    }
    this.#endTurn();
    this.settle();
  }

  /**
   * Fold one frame into the blocks.
   *
   * @param {Frame} frame
   * @returns {boolean} whether anything visible changed
   */
  event(frame) {
    switch (frame.type) {
      case "agent_start":
        this.#turn += 1;
        this.#running = true;
        this.#closeMessage();
        return false;

      case "agent_end":
        this.#closeMessage();
        if (frame.willRetry !== true) {
          this.#running = false;
          this.#endTurn();
        }
        return false;

      case "agent_settled":
        this.#running = false;
        this.#endTurn();
        this.settle();
        return true;

      case "turn_start":
        this.#closeMessage();
        return false;

      case "turn_end":
        this.#closeMessage();
        return false;

      case "message_start":
        return this.#messageStart(/** @type {Message} */ (frame.message));

      case "message_end":
        return this.#messageEnd(/** @type {Message} */ (frame.message));

      case "message_update":
        return this.#update(frame);

      case "tool_execution_start": {
        const block = this.#tool(frame.toolCallId ?? "", frame.toolName);
        block.args = frame.args ?? null;
        block.title = toolSummary(block.toolName ?? "tool", block.args ?? undefined);
        block.startedAt ??= stamp(frame);
        return true;
      }

      case "tool_execution_update": {
        const block = this.#tools.get(frame.toolCallId ?? "");
        if (!block) return false;
        block.progress = frame.partialResult ?? null;
        return true;
      }

      case "tool_execution_end": {
        const block = this.#tool(frame.toolCallId ?? "", frame.toolName);
        block.result = frame.result ?? null;
        this.#pictures(block, frame.result);
        if (frame.details !== undefined) block.details = frame.details;
        block.isError = frame.isError === true;
        block.done = true;
        block.progress = null;
        this.#finish(block, stamp(frame));
        block.startedAt ??= block.doneAt;
        if (typeof frame.durationMs === "number") block.durationMs = frame.durationMs;
        return true;
      }

      case "bash_execution_update":
        return this.#shell(frame.id ?? "bash", frame.delta ?? "");

      case "auto_retry_start":
        this.#push({
          kind: "status",
          id: nextId++,
          level: "retry",
          text: `attempt ${frame.attempt ?? 1}/${frame.maxAttempts ?? "?"} in ${Math.round((frame.delayMs ?? 0) / 1000)}s — ${frame.errorMessage ?? "unknown error"}`,
        });
        return true;

      case "auto_retry_end":
        if (frame.success === true) return false;
        this.#push({ kind: "error", id: nextId++, text: frame.finalError ?? "Wiederholung fehlgeschlagen" });
        return true;

      case "summarization_retry_scheduled":
        this.#push({
          kind: "status",
          id: nextId++,
          level: "retry",
          text: `Kompaktierung erneut versucht (${frame.attempt ?? 1}/${frame.maxAttempts ?? "?"})`,
        });
        return true;

      case "compaction_start":
        this.#push({
          kind: "status",
          id: nextId++,
          level: "info",
          text: `compacting context (${frame.reason ?? "?"})`,
        });
        return true;

      case "compaction_end":
        return this.#compaction(frame);

      case "queue_update":
        this.#queue = [...(frame.steering ?? []), ...(frame.followUp ?? [])];
        return false;

      case "extension_error":
        this.#push({
          kind: "error",
          id: nextId++,
          text: `${frame.extensionPath ?? "extension"} bei ${frame.event ?? "?"}: ${frame.error ?? ""}`,
        });
        return true;

      default:
        return false;
    }
  }

  /** Close everything still open: a run that finished while the page was away
   *  never sent its `message_end`. */
  settle() {
    for (const block of this.#blocks) {
      if (block.kind === "text" || block.kind === "thinking" || block.kind === "tool" || block.kind === "bash") {
        block.done = true;
      }
    }
    this.#current = { text: [], thinking: [] };
  }

  /**
   * @param {Message | undefined} message
   */
  #messageStart(message) {
    if (!message) return false;

    if (message.role === "assistant") {
      this.#current = { text: [], thinking: [] };
      return false;
    }

    this.#message(message, false);
    return true;
  }

  /**
   * @param {Frame} frame
   */
  #update(frame) {
    const event = frame.assistantMessageEvent;
    if (!event?.type) return false;
    if (frame.usage) this.#usage = frame.usage;

    const index = typeof event.contentIndex === "number" ? event.contentIndex : 0;

    switch (event.type) {
      case "text_start":
        this.#slot("text", index);
        return true;

      case "text_delta": {
        const block = this.#slot("text", index);
        block.text = (block.text ?? "") + (event.delta ?? "");
        block.usage = frame.usage ?? block.usage ?? null;
        return true;
      }

      case "text_end": {
        const block = this.#slot("text", index);
        if (typeof event.content === "string") block.text = event.content;
        return true;
      }

      case "thinking_start":
        this.#slot("thinking", index);
        return true;

      case "thinking_delta": {
        const block = this.#slot("thinking", index);
        block.text = (block.text ?? "") + (event.delta ?? "");
        return true;
      }

      case "thinking_end": {
        const block = this.#slot("thinking", index);
        if (typeof event.content === "string") block.text = event.content;
        return true;
      }

      case "toolcall_start": {
        const block = this.#tool(event.id ?? `call-${index}`, event.toolName);
        block.startedAt ??= Date.now();
        this.#tools.set(event.id ?? `call-${index}`, block);
        return true;
      }

      case "toolcall_delta": {
        const block = this.#lastTool();
        if (!block) return false;
        block.argsText = (block.argsText ?? "") + (event.delta ?? "");
        return true;
      }

      case "toolcall_end": {
        const call = event.toolCall;
        if (!call?.id) return false;
        const block = this.#tool(call.id, call.name);
        block.args = /** @type {Record<string, unknown>} */ (call.arguments ?? null);
        block.title = toolSummary(call.name ?? "tool", block.args ?? undefined);
        return true;
      }

      case "done":
      case "error":
        this.#closeMessage();
        return false;

      default:
        return false;
    }
  }

  /**
   * The authoritative version of the message that just streamed.
   *
   * @param {Message | undefined} message
   */
  #messageEnd(message) {
    if (!message) return false;

    if (message.role !== "assistant") {
      const block = this.#blocks.find((item) => item.kind === "user" && !item.done);
      if (block) block.done = true;
      return false;
    }

    const parts = blocks(message.content);
    const texts = parts.filter((part) => part.type === "text");
    const thinking = parts.filter((part) => part.type === "thinking");

    const openText = compact(this.#current.text);
    texts.forEach((part, index) => {
      const block = openText[index] ?? this.#slot("text", openText.length);
      block.text = part.text ?? "";
      block.done = true;
    });

    const openThinking = compact(this.#current.thinking);
    thinking.forEach((part, index) => {
      const block = openThinking[index] ?? this.#slot("thinking", openThinking.length);
      block.text = part.thinking ?? "";
      block.done = true;
    });

    // A turn can end on a thought: the model stops after thinking and never
    // says anything. That thought is then all the reader gets, so it has to
    // read as an answer rather than as a note folded away above one.
    if (texts.length === 0 && thinking.length > 0 && message.stopReason === "stop") {
      const thought = openThinking[openThinking.length - 1];
      if (thought) thought.lastWord = true;
    }

    const miss = this.#cache.see(message);
    const told = notice(miss);
    this.#collect(message.usage ?? null, miss);

    const last = this.#current.text[this.#current.text.length - 1];
    if (last) {
      last.cacheMiss = told;
      last.usage = message.usage ?? null;
      last.stopReason = message.stopReason ?? null;
      if (message.errorMessage) last.error = message.errorMessage;
    }
    for (const thought of compact(this.#current.thinking)) {
      thought.request = message.usage ?? null;
      thought.cacheMiss = told;
    }
    for (const part of parts) {
      if (part.type !== "toolCall" || !part.id) continue;
      const told2 = this.#tools.get(part.id);
      if (told2) {
        told2.request = message.usage ?? null;
        told2.cacheMiss = told;
      }
    }

    this.#usage = message.usage ?? this.#usage;
    this.#closeMessage();
    return true;
  }

  /**
   * Adds one request to the running total of the turn.
   *
   * @param {Usage | null} usage
   * @param {import("./cache.js").Miss | undefined} miss
   */
  #collect(usage, miss) {
    if (usage) {
      this.#tally.requests += 1;
      this.#tally.input += usage.input ?? 0;
      this.#tally.cacheRead += usage.cacheRead ?? 0;
      this.#tally.cacheWrite += usage.cacheWrite ?? 0;
      this.#tally.output += usage.output ?? 0;
      this.#tally.cost += usage.cost?.total ?? 0;
    }
    if (miss) {
      this.#tally.missed += miss.missedTokens;
      this.#tally.missedCost += miss.missedCost;
    }
  }

  /** Hands the total of a finished turn to the answer it ended with. */
  #endTurn() {
    const answer = this.#lastAnswer;
    if (answer && this.#tally.requests > 0 && this.#blocks.includes(answer)) answer.turn = { ...this.#tally };
    this.#tally = blankTally();
    this.#lastAnswer = null;
  }

  /**
   * @param {Message} message
   * @param {boolean} replayed
   */
  #message(message, replayed) {
    if (message.role === "compactionSummary") {
      this.#cache.forget();
      this.#push({
        kind: "compaction",
        id: nextId++,
        text:
          typeof message.tokensBefore === "number" ? `${message.tokensBefore} tokens compacted` : "context compacted",
        summary: message.summary ?? null,
        done: true,
      });
      return;
    }

    if (message.role === "branchSummary") {
      this.#cache.forget();
      this.#push({
        kind: "compaction",
        id: nextId++,
        text: "branch summary",
        summary: message.summary ?? null,
        done: true,
      });
      return;
    }

    if (message.role === "user") {
      this.#endTurn();
      const images = /** @type {Image[]} */ (
        imagesOf(message.content).map((part) => ({ mimeType: part.mimeType ?? "image/png", data: part.data ?? "" }))
      );
      const text = blocks(message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");

      if (!text && images.length === 0) return;

      if (text.startsWith("!")) {
        this.#push({ kind: "bash", id: nextId++, text: text.slice(1).trim(), done: replayed });
        return;
      }
      this.#push({ kind: "user", id: nextId++, text, images, done: true });
      return;
    }

    if (message.role === "toolResult") {
      const block = this.#tool(message.toolCallId ?? "", message.toolName);
      block.result = message.content ?? null;
      this.#pictures(block, message.content);
      if (message.details !== undefined) block.details = message.details;
      block.isError = message.isError === true;
      block.done = true;
      if (typeof message.durationMs === "number") block.durationMs = message.durationMs;
      this.#finish(block, stamped(message) ?? block.doneAt ?? Date.now());
      return;
    }

    const parts = blocks(message.content);
    const miss = this.#cache.see(message);
    const told = notice(miss);
    this.#collect(message.usage ?? null, miss);
    /** @type {Block | undefined} */
    let thought;
    /** @type {Block | undefined} */
    let said;
    for (const part of parts) {
      if (part.type === "thinking") {
        thought = { kind: "thinking", id: nextId++, text: part.thinking ?? "", done: true };
        this.#push(thought);
      } else if (part.type === "text") {
        const text = part.text ?? "";
        if (text.trim().length === 0 && !message.usage) continue;
        said = { kind: "text", id: nextId++, text, done: true, usage: message.usage ?? null };
        this.#push(said);
        this.#lastAnswer = said;
      } else if (part.type === "toolCall") {
        const block = this.#tool(part.id ?? `call-${nextId++}`, part.name);
        block.args = /** @type {Record<string, unknown>} */ (part.arguments ?? null);
        block.startedAt ??= stamped(message);
        block.request = message.usage ?? null;
        block.cacheMiss = told;
      }
    }

    if (thought) {
      thought.request = message.usage ?? null;
      thought.cacheMiss = told;
    }
    if (said) said.cacheMiss = told;
    if (thought && message.stopReason === "stop" && !parts.some((part) => part.type === "text")) {
      thought.lastWord = true;
    }
  }

  /**
   * @param {Frame} frame
   */
  #compaction(frame) {
    const result = frame.result ?? null;
    const summary =
      result && typeof result === "object" ? /** @type {{summary?: string}} */ (result).summary : undefined;
    const before =
      result && typeof result === "object" ? /** @type {{tokensBefore?: number}} */ (result).tokensBefore : undefined;
    const billed = result && typeof result === "object" ? /** @type {{usage?: Usage}} */ (result).usage : undefined;

    if (frame.aborted === true) {
      this.#push({ kind: "status", id: nextId++, level: "info", text: "Kompaktierung abgebrochen" });
      return true;
    }

    this.#cache.forget();

    this.#push({
      kind: "compaction",
      id: nextId++,
      text: typeof before === "number" ? `${before} tokens compacted` : "context compacted",
      summary: summary ?? frame.errorMessage ?? null,
      usage: billed ?? null,
    });
    return true;
  }

  /**
   * @param {string} id
   * @param {string} delta
   */
  #shell(id, delta) {
    const existing = this.#shells.get(id);
    if (existing) {
      existing.text = (existing.text ?? "") + delta;
      return true;
    }

    /** @type {Block} */
    const block = { kind: "bash", id: nextId++, text: delta, done: false };
    this.#shells.set(id, block);
    this.#push(block);
    return true;
  }

  /**
   * The pictures a tool handed back. They live on the block rather than in its
   * text, so the page can show the image instead of a line about it.
   *
   * @param {Block} block
   * @param {unknown} content
   */
  #pictures(block, content) {
    const found = imagesOf(content);
    if (found.length === 0) return;
    block.images = found.map((part) => ({ mimeType: part.mimeType ?? "image/png", data: part.data ?? "" }));
  }

  /**
   * @param {string | undefined} id
   * @param {string | undefined} name
   */
  #tool(id, name) {
    const key = id ?? "";
    const existing = this.#tools.get(key);
    if (existing) {
      if (name && existing.toolName !== "tool") existing.toolName = name;
      if (name) existing.title = toolSummary(name, existing.args ?? undefined);
      return existing;
    }

    /** @type {Block} */
    const block = {
      kind: "tool",
      id: nextId++,
      toolCallId: key,
      toolName: name ?? "tool",
      title: toolSummary(name ?? "tool", undefined),
      args: null,
      done: false,
    };
    this.#tools.set(key, block);
    this.#push(block);
    return block;
  }

  /**
   * Close a tool row out. The frames and the stored messages describe the same
   * finish from two clocks, so the row ends at whichever of them is later and
   * never walks back; a start that landed after the finish is pulled up to it,
   * which leaves a zero-length run rather than a negative one.
   *
   * @param {Block} block
   * @param {number} when
   */
  #finish(block, when) {
    block.doneAt = Math.max(block.doneAt ?? 0, when);
    if (block.startedAt !== undefined && block.startedAt > block.doneAt) block.startedAt = block.doneAt;
  }

  /** @returns {Block | undefined} */
  #lastTool() {
    for (let index = this.#blocks.length - 1; index >= 0; index -= 1) {
      if (this.#blocks[index].kind === "tool") return this.#blocks[index];
    }
    return undefined;
  }

  /**
   * The block a delta belongs to. Pi numbers the content parts of one message,
   * so an index seen for the first time opens a block here.
   *
   * @param {"text" | "thinking"} kind
   * @param {number} index
   */
  #slot(kind, index) {
    const list = kind === "text" ? this.#current.text : this.#current.thinking;
    const known = list[index];
    if (known) return known;

    /** @type {Block} */
    const block = { kind, id: nextId++, text: "", done: false };
    list[index] = block;
    if (kind === "text") this.#lastAnswer = block;
    this.#push(block);
    return block;
  }

  /** @param {Block} block */
  #push(block) {
    this.#blocks.push(block);
  }

  #closeMessage() {
    for (const block of [...compact(this.#current.text), ...compact(this.#current.thinking)]) block.done = true;
    for (const block of compact(this.#current.text)) {
      if ((block.text ?? "").trim().length > 0 || block.usage || block.error) continue;
      const at = this.#blocks.indexOf(block);
      if (at >= 0) this.#blocks.splice(at, 1);
    }
    this.#current = { text: [], thinking: [] };
  }
}

/**
 * A slot list is indexed by pi's `contentIndex`, so it has holes: a message with
 * only thinking never opened index 1. Compacting gives the nth real block, which
 * is what the nth part of that kind belongs to.
 *
 * @param {(Block | undefined)[]} slots
 * @returns {Block[]}
 */
function compact(slots) {
  /** @type {Block[]} */
  const out = [];
  for (const slot of slots) if (slot) out.push(slot);
  return out;
}

/**
 * When a frame happened. Live events carry epoch milliseconds, a restored
 * session carries the ISO string it was written with.
 *
 * @param {Frame} frame
 */
function stamp(frame) {
  return stamped(frame) ?? Date.now();
}

/**
 * When a frame or a stored message says something happened, in epoch
 * milliseconds. pi stamps both the same way, live and on disk.
 *
 * @param {Frame | Message} frame
 * @returns {number | undefined}
 */
function stamped(frame) {
  if (typeof frame.timestamp === "number" && Number.isFinite(frame.timestamp)) return frame.timestamp;
  const parsed = Date.parse(String(frame.timestamp ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}
