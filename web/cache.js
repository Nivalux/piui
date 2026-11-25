// @ts-check

/**
 * What the prompt cache gave back, read out of the usage pi reports with every answer.
 *
 * @typedef {import("./protocol.js").Usage} Usage
 * @typedef {import("./protocol.js").Message} Message
 *
 * @typedef {Object} Miss
 * @property {number} missedTokens prompt tokens the request before also had, that came back uncached
 * @property {number} missedCost what those tokens cost above a cache read, 0 where nothing is priced
 * @property {number} idleMs milliseconds since the request that last refreshed the cache
 * @property {boolean} modelChanged the answer came from another model than the request before it
 *
 * @typedef {{missedTokens: number, missedCost: number, missCount: number}} Waste
 */

/** Past this much silence the cache is gone, so a miss after it has a known reason. */
export const cacheTtlMs = 5 * 60 * 1000;

/** A drop this small is where a cache breakpoint happened to sit, not a miss. */
const noiseFloorTokens = 1024;

/** Under both of these the reader is better off without the notice. */
const noticeTokens = 20_000;
const noticeCost = 0.1;

/**
 * The miss worth a line of its own, or null when there is nothing to say about this answer.
 *
 * @param {Miss | undefined} miss
 * @returns {Miss | null}
 */
export function notice(miss) {
  if (!miss) return null;
  return miss.missedTokens >= noticeTokens || miss.missedCost >= noticeCost ? miss : null;
}

/** Walks finished answers in the order the model was asked, one request at a time. */
export class CacheWatch {
  /** @type {{prompt: number, model: string, at: number, cached: boolean} | null} */
  #before = null;
  #missedTokens = 0;
  #missedCost = 0;
  #missCount = 0;

  /** Drop the comparison: content the context threw away on purpose was never meant to be read from cache. */
  forget() {
    this.#before = null;
  }

  /** @returns {Waste} */
  get waste() {
    return { missedTokens: this.#missedTokens, missedCost: this.#missedCost, missCount: this.#missCount };
  }

  /**
   * One finished answer; nothing for a first one, for a provider that never reports caching, or for a breakpoint-sized drop.
   *
   * @param {Message} message
   * @returns {Miss | undefined}
   */
  see(message) {
    const usage = message.usage ?? /** @type {Usage} */ ({});
    const read = usage.cacheRead ?? 0;
    const written = usage.cacheWrite ?? 0;
    const paid = (usage.input ?? 0) + written;
    const prompt = paid + read;
    const model = `${message.provider ?? ""}/${message.model ?? ""}`;
    const at = stamp(message);
    const before = this.#before;

    if (prompt > 0) {
      this.#before = { prompt, model, at, cached: (before?.cached ?? false) || read + written > 0 };
    }

    if (!before || prompt <= 0 || (read + written === 0 && !before.cached)) return undefined;

    const missedTokens = Math.min(before.prompt, prompt) - read;
    if (missedTokens <= noiseFloorTokens) return undefined;

    const paidPerToken = paid > 0 ? ((usage.cost?.input ?? 0) + (usage.cost?.cacheWrite ?? 0)) / paid : 0;
    const readPerToken = read > 0 ? (usage.cost?.cacheRead ?? 0) / read : 0;

    const miss = {
      missedTokens,
      missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
      idleMs: at > 0 && before.at > 0 ? Math.max(0, at - before.at) : 0,
      modelChanged: model !== before.model,
    };

    this.#missedTokens += missedTokens;
    this.#missedCost += miss.missedCost;
    this.#missCount += 1;
    return miss;
  }
}

/** @param {Message} message */
function stamp(message) {
  const at = message.timestamp;
  if (typeof at === "number") return at;
  if (typeof at === "string") {
    const parsed = Date.parse(at);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}
