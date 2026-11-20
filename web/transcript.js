// @ts-check

/**
 * The transcript, folded from pi's events.
 *
 * pi speaks two layers at once: the transcript itself (`message_start`,
 * `message_update`, `message_end`) and the machinery around it
 * (`tool_execution_*`, `turn_end`, `auto_retry_start`). One assistant message
 * arrives as a start, a hundred deltas and an authoritative end, and a tool call
 * announces itself twice — once from the model, once from the runner. This folds
 * all of that into one ordered list of blocks, and it never touches the DOM, so
 * the whole thing is testable against the fixtures in `testdata/`.
 *
 * `message_end` wins: whatever the deltas produced is overwritten by the final
 * message, the way the docs ask a consumer to treat it.
 *
 * Blocks:
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

import { toolSummary } from "./format.js";
import { blocks, imagesOf } from "./protocol.js";

/**
 * @typedef {import("./protocol.js").Frame} Frame
 * @typedef {import("./protocol.js").Message} Message
 * @typedef {import("./protocol.js").Content} Content
 * @typedef {import("./protocol.js").Usage} Usage
 * @typedef {import("./protocol.js").AssistantEvent} AssistantEvent
 * @typedef {{mimeType: string, data: string}} Image
 */

/**
 * One rendered thing in the transcript. Which fields mean something depends on
 * `kind`; keeping it one shape is what lets the page diff blocks by identity
 * instead of knowing eight variants.
 *
 * @typedef {Object} Block
 * @property {"user" | "thinking" | "text" | "tool" | "bash" | "compaction" | "status" | "error"} kind
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
 */

let nextId = 0;

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

  clear() {
    this.#blocks = [];
    this.#tools.clear();
    this.#shells.clear();
    this.#current = { text: [], thinking: [] };
    this.#usage = null;
    this.#queue = [];
  }

  /**
   * A stored transcript, from the `get_messages` response.
   *
   * A chat that is still working replays with its unfinished tool left open:
   * the run goes on behind this tab, and coming back must not turn a running
   * bash into a finished one, nor lose the clock that counts it. Only a chat at
   * rest gets everything closed.
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
        if (frame.willRetry !== true) this.#running = false;
        return false;

      case "agent_settled":
        this.#running = false;
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
        block.doneAt = stamp(frame);
        block.startedAt ??= block.doneAt;
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
        this.#push({ kind: "status", id: nextId++, level: "info", text: `compacting context (${frame.reason ?? "?"})` });
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

    const last = this.#current.text[this.#current.text.length - 1];
    if (last) {
      last.usage = message.usage ?? null;
      last.stopReason = message.stopReason ?? null;
      if (message.errorMessage) last.error = message.errorMessage;
    }

    this.#usage = message.usage ?? this.#usage;
    this.#closeMessage();
    return true;
  }

  /**
   * @param {Message} message
   * @param {boolean} replayed
   */
  #message(message, replayed) {
    if (message.role === "user") {
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
      block.doneAt = stamped(message) ?? block.doneAt ?? Date.now();
      block.startedAt ??= block.doneAt;
      return;
    }

    const parts = blocks(message.content);
    for (const part of parts) {
      if (part.type === "thinking") {
        this.#push({ kind: "thinking", id: nextId++, text: part.thinking ?? "", done: true });
      } else if (part.type === "text") {
        this.#push({ kind: "text", id: nextId++, text: part.text ?? "", done: true, usage: message.usage ?? null });
      } else if (part.type === "toolCall") {
        const block = this.#tool(part.id ?? `call-${nextId++}`, part.name);
        block.args = /** @type {Record<string, unknown>} */ (part.arguments ?? null);
        block.startedAt ??= stamped(message);
      }
    }
  }

  /**
   * @param {Frame} frame
   */
  #compaction(frame) {
    const result = frame.result ?? null;
    const summary = result && typeof result === "object" ? /** @type {{summary?: string}} */ (result).summary : undefined;
    const before =
      result && typeof result === "object" ? /** @type {{tokensBefore?: number}} */ (result).tokensBefore : undefined;

    if (frame.aborted === true) {
      this.#push({ kind: "status", id: nextId++, level: "info", text: "Kompaktierung abgebrochen" });
      return true;
    }

    this.#push({
      kind: "compaction",
      id: nextId++,
      text: typeof before === "number" ? `${before} tokens compacted` : "context compacted",
      summary: summary ?? frame.errorMessage ?? null,
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
    this.#push(block);
    return block;
  }

  /** @param {Block} block */
  #push(block) {
    this.#blocks.push(block);
  }

  #closeMessage() {
    for (const block of [...compact(this.#current.text), ...compact(this.#current.thinking)]) block.done = true;
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
