/**
 * Tokens per second for the chat footer.
 *
 * Pi reports usage once a message ends, so a live number has to be estimated
 * from the streamed characters until that arrives. The estimate is cumulative
 * rather than sampled, which keeps it steady instead of flickering, and the
 * exact count replaces it the moment pi sends it.
 */

/** @typedef {import("./protocol.js").Usage} Usage */

/**
 * @typedef {Object} Reading
 * @property {number} tokens output tokens so far
 * @property {number} tokensPerSecond
 * @property {number} elapsedMs
 * @property {boolean} exact false while the character estimate is in use
 */

/** Characters per token, the rule of thumb every tokenizer agrees close enough. */
const characters_per_token = 4;

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
   * Usage from a `message_end`. Cumulative across the run, because pi counts per
   * message and the footer shows the run.
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
    if (this.#start === null) return { tokens: 0, tokensPerSecond: 0, elapsedMs: 0, exact: false };

    const elapsed = Math.max(1, (this.#end ?? atMs) - this.#start);
    const estimated = this.#characters / characters_per_token;
    const tokens = this.#reported ?? estimated;
    return {
      tokens,
      tokensPerSecond: (tokens / elapsed) * 1000,
      elapsedMs: elapsed,
      exact: this.#reported !== null,
    };
  }

  /** Cost of the run, once pi has reported any. */
  cost() {
    const total = this.#usage?.cost?.total;
    return typeof total === "number" ? total : 0;
  }
}
