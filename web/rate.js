/**
 * Tokens per second for the chat footer.
 *
 * @typedef {import("./protocol.js").Usage} Usage
 * @typedef {import("./protocol.js").Message} Message
 *
 * @typedef {Object} Reading
 * @property {number} tokens output tokens so far
 * @property {number} tokensPerSecond
 * @property {boolean} exact false while the character estimate is in use
 */
const characters_per_token = 4;

/**
 * How many finished answers the pace is drawn over. One is a coincidence, all of them is the whole
 * chat, and three is about what a reader remembers of how fast this model has been writing.
 */
const remembered_turns = 3;

export class Meter {
  /** @type {number | null} */
  #start = null;
  /** @type {number | null} */
  #end = null;
  #characters = 0;
  /** @type {number | null} */
  #reported = null;
  /** @type {Usage | null} */
  #usage = null;
  /** @type {{tokens: number, ms: number}[]} */
  #turns = [];

  reset() {
    this.#start = null;
    this.#end = null;
    this.#characters = 0;
    this.#reported = null;
    this.#usage = null;
    this.#turns = [];
  }

  /** Begin a run. Calling it again starts over, which is what a new prompt does. */
  start(atMs = Date.now()) {
    this.#start = atMs;
    this.#end = null;
    this.#characters = 0;
    this.#reported = null;
    this.#usage = null;
  }

  /** Mark the end of a run; the rate then reflects the whole run, not the live tail. */
  stop(atMs = Date.now()) {
    if (this.#start !== null && this.#end === null) this.#end = Math.max(atMs, this.#start);
  }

  /** Streamed text. Only counted while running: a replayed transcript is not a rate. */
  addText(/** @type {string} */ text) {
    if (this.#start !== null && this.#end === null) this.#characters += text.length;
  }

  /**
   * Usage from a `message_end`. Cumulative across the run, because pi counts per message and the
   * footer shows the run.
   *
   * @param {Usage | undefined} usage
   */
  addUsage(usage) {
    const output = usage?.output;
    if (typeof output !== "number" || !Number.isFinite(output)) return;
    this.#reported = (this.#reported ?? 0) + output;
    this.#usage = usage ?? null;
  }

  /** @returns {boolean} */
  get running() {
    return this.#start !== null && this.#end === null;
  }

  /**
   * @param {number} [atMs]
   * @returns {Reading}
   */
  reading(atMs = Date.now()) {
    if (this.#start === null) return { tokens: 0, tokensPerSecond: 0, exact: false };

    const elapsed = Math.max(1, (this.#end ?? atMs) - this.#start);
    const estimated = this.#characters / characters_per_token;
    const tokens = this.#reported ?? estimated;
    return {
      tokens,
      tokensPerSecond: (tokens / elapsed) * 1000,
      exact: this.#reported !== null,
    };
  }

  /**
   * One finished model turn: what it wrote and how long it took. A turn that wrote nothing, or
   * that only blinked, says nothing about speed.
   *
   * @param {number} tokens
   * @param {number} ms
   */
  turn(tokens, ms) {
    if (!(tokens > 0) || !(ms > 200) || ms > 600_000) return;
    this.#turns.push({ tokens, ms });
    if (this.#turns.length > remembered_turns) this.#turns.shift();
  }

  /**
   * Tokens per second over the answers that are finished. Worth more than a guess about the one
   * still arriving, and it is there after a reload.
   */
  pace() {
    let tokens = 0;
    let ms = 0;
    for (const sample of this.#turns) {
      tokens += sample.tokens;
      ms += sample.ms;
    }
    return ms > 0 ? (tokens / ms) * 1000 : 0;
  }

  /**
   * The pace of a chat that was just opened, measured from the messages it was read with. A turn
   * is timed from the line before it: that is where pi stopped waiting for a tool and started
   * writing.
   *
   * @param {Message[]} messages
   */
  history(messages) {
    this.#turns = [];
    /** @type {number | undefined} */
    let previous;
    for (const message of messages) {
      const at = epoch(message.timestamp);
      const output = message.role === "assistant" ? message.usage?.output : undefined;
      if (previous !== undefined && at !== undefined && typeof output === "number") {
        this.turn(output, at - previous);
      }
      if (at !== undefined) previous = at;
    }
  }

  /** Cost of the run, once pi has reported any. */
  cost() {
    const total = this.#usage?.cost?.total;
    return typeof total === "number" ? total : 0;
  }
}

/**
 * When something happened, in epoch milliseconds. pi sends a number live and an ISO string on
 * disk.
 *
 * @param {number | string | undefined} value
 * @returns {number | undefined}
 */
function epoch(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}
