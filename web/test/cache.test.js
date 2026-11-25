// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import { CacheWatch, cacheTtlMs, notice } from "../cache.js";

/**
 * @param {{input?: number, cacheRead?: number, cacheWrite?: number, cost?: {input?: number, cacheRead?: number, cacheWrite?: number}, model?: string, provider?: string, at?: number}} over
 */
function answer(over) {
  return {
    role: /** @type {const} */ ("assistant"),
    provider: over.provider ?? "acme",
    model: over.model ?? "big",
    timestamp: over.at ?? 1000,
    usage: {
      input: over.input ?? 0,
      output: 20,
      cacheRead: over.cacheRead ?? 0,
      cacheWrite: over.cacheWrite ?? 0,
      cost: over.cost ?? {},
    },
  };
}

test("the first answer of a chat has nothing to have missed", () => {
  const watch = new CacheWatch();
  assert.equal(watch.see(answer({ input: 1000, cacheRead: 90_000 })), undefined);
});

test("a prompt the cache handed whole back is no miss", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 90_000 }));
  assert.equal(watch.see(answer({ input: 2000, cacheRead: 91_000 })), undefined);
});

test("a prompt that came back whole but uncached is billed again", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 90_000 }));
  const miss = watch.see(answer({ input: 91_000, cacheRead: 0 }));
  assert.ok(miss);
  assert.equal(miss.missedTokens, 91_000);
  assert.equal(miss.modelChanged, false);
});

test("a drop the size of a cache breakpoint is not a miss", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 90_000 }));
  assert.equal(watch.see(answer({ input: 1000, cacheRead: 89_200 })), undefined);
});

test("a provider that never reports caching has no cache to miss", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000 }));
  assert.equal(watch.see(answer({ input: 40_000 })), undefined);
  assert.equal(watch.waste.missCount, 0);
});

test("a provider that stops reporting caching at all is missing everything", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 40_000 }));
  const miss = watch.see(answer({ input: 41_000, cacheRead: 0, cacheWrite: 0 }));
  assert.ok(miss);
  assert.equal(miss.missedTokens, 41_000);
});

test("what the context threw away on purpose was never meant for the cache", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 90_000 }));
  watch.forget();
  assert.equal(watch.see(answer({ input: 91_000, cacheRead: 0 })), undefined);
});

test("another model answering is named as the reason", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 90_000 }));
  const miss = watch.see(answer({ input: 91_000, cacheRead: 0, model: "small" }));
  assert.ok(miss);
  assert.equal(miss.modelChanged, true);
});

test("another provider answering is named as the reason", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 90_000 }));
  const miss = watch.see(answer({ input: 91_000, cacheRead: 0, provider: "other" }));
  assert.ok(miss);
  assert.equal(miss.modelChanged, true);
});

test("the gap since the request that refreshed the cache is what it expired on", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 90_000, at: 1_700_000_000_000 }));
  const miss = watch.see(answer({ input: 91_000, cacheRead: 0, at: 1_700_000_000_000 + cacheTtlMs + 60_000 }));
  assert.ok(miss);
  assert.equal(miss.idleMs, cacheTtlMs + 60_000);
});

test("an answer stamped with a text date knows how long it waited", () => {
  const watch = new CacheWatch();
  watch.see({ ...answer({ input: 1000, cacheRead: 90_000 }), timestamp: "2026-01-01T10:00:00.000Z" });
  const miss = watch.see({ ...answer({ input: 91_000, cacheRead: 0 }), timestamp: "2026-01-01T10:09:00.000Z" });
  assert.ok(miss);
  assert.equal(miss.idleMs, 9 * 60 * 1000);
});

test("missed tokens are billed at the rate the answer actually paid", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 100_000, cost: { cacheRead: 0.1 } }));
  const miss = watch.see(answer({ input: 20_000, cacheRead: 81_000, cost: { input: 0.2, cacheRead: 0.08 } }));
  assert.ok(miss);
  assert.equal(miss.missedTokens, 20_000);
  assert.ok(Math.abs(miss.missedCost - 20_000 * (0.2 / 20_000 - 0.08 / 81_000)) < 1e-9);
});

test("a local model that prices nothing misses tokens at no cost", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 90_000 }));
  const miss = watch.see(answer({ input: 91_000, cacheRead: 0 }));
  assert.ok(miss);
  assert.equal(miss.missedCost, 0);
});

test("the waste adds up over a chat and outlives a compaction", () => {
  const watch = new CacheWatch();
  watch.see(answer({ input: 1000, cacheRead: 90_000 }));
  watch.see(answer({ input: 91_000, cacheRead: 0 }));
  watch.forget();
  watch.see(answer({ input: 5000, cacheRead: 60_000 }));
  watch.see(answer({ input: 65_000, cacheRead: 0 }));
  const waste = watch.waste;
  assert.equal(waste.missCount, 2);
  assert.equal(waste.missedTokens, 91_000 + 65_000);
});

test("a miss only earns a line once it is worth reading about", () => {
  const small = { missedTokens: 19_999, missedCost: 0.09, idleMs: 0, modelChanged: false };
  assert.equal(notice(small), null);
  assert.equal(notice(undefined), null);
  assert.ok(notice({ ...small, missedTokens: 20_000 }));
  assert.ok(notice({ ...small, missedCost: 0.1 }));
});
