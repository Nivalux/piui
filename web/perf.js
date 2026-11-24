// @ts-check

/**
 * A meter for the running page, switched on by the reader in their own browser
 * with `localStorage.setItem("piui:perf", "1")` and a reload.
 */

/** @type {boolean} */
const on = typeof localStorage !== "undefined" && localStorage.getItem("piui:perf") === "1";

/** @type {Map<string, { calls: number, ms: number, amount: number }>} */
const tallies = new Map();

const meter = { on, frames: 0, gap: 0 };

/**
 * Count one thing happening: how many times, and how much of it.
 *
 * @param {string} name
 * @param {number} [count]
 * @param {number} [amount]
 */
export function note(name, count = 1, amount = 0) {
  if (!on) return;
  const tally = tallies.get(name) ?? { calls: 0, ms: 0, amount: 0 };
  tally.calls += count;
  tally.amount += amount;
  tallies.set(name, tally);
}

/** Where the clock starts for a named piece of work; nothing when the meter is off.
 *
 * @returns {number}
 */
export function start() {
  return on ? performance.now() : 0;
}

/**
 * Record one call of named work and how long it took.
 *
 * @param {string} name
 * @param {number} started
 */
export function took(name, started) {
  if (!on) return;
  const tally = tallies.get(name) ?? { calls: 0, ms: 0, amount: 0 };
  tally.calls += 1;
  tally.ms += performance.now() - started;
  tallies.set(name, tally);
}

/** @param {number} value */
function compact(value) {
  return value > 999999
    ? `${(value / 1048576).toFixed(1)}M`
    : value > 999
      ? `${Math.round(value / 1000)}k`
      : String(Math.round(value));
}

if (on) {
  Object.assign(window, { __perf: { tallies, meter } });
  console.log("[piui] meter on: one line every five seconds, window.__perf for the live totals");
  setInterval(() => {
    const rows = [...tallies.entries()]
      .sort((a, b) => b[1].ms - a[1].ms || b[1].calls - a[1].calls)
      .map(
        ([name, tally]) =>
          `${name} ${tally.calls}x ${Math.round(tally.ms)}ms${tally.amount ? ` ${compact(tally.amount)}` : ""}`,
      );
    console.log(
      `[piui] 5s: ${rows.join(" | ")} | frames ${meter.frames} | gap ${meter.gap.toFixed(1)}ms | nodes ${document.getElementsByTagName("*").length}`,
    );
    for (const tally of tallies.values()) {
      tally.calls = 0;
      tally.ms = 0;
      tally.amount = 0;
    }
    meter.frames = 0;
  }, 5000);
}

export const live = meter;
