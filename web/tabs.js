// @ts-check

/**
 * The order of the sidebar, and which chats are still waiting to be read.
 *
 * Working chats lead, settled ones follow. A settled chat is ordered by what it
 * did last; a working one holds the place its run started in, because a list
 * that reshuffles every few seconds is a list you cannot click. A run that
 * ended while the reader was somewhere else stays marked until they look.
 *
 * @typedef {import("./protocol.js").TabInfo} TabInfo
 */

/**
 * @param {TabInfo[]} tabs
 * @returns {{working: TabInfo[], settled: TabInfo[]}}
 */
export function splitTabs(tabs) {
  return { working: byRun(tabs.filter((tab) => tab.running)), settled: byActivity(tabs.filter((tab) => !tab.running)) };
}

/**
 * Ordered by the moment each chat last did something. Only safe once a chat is
 * quiet: while it runs, this number moves with every token.
 *
 * @param {TabInfo[]} tabs
 * @returns {TabInfo[]}
 */
export function byActivity(tabs) {
  return tabs.slice().sort((left, right) => stamp(right) - stamp(left) || left.id.localeCompare(right.id));
}

/**
 * Ordered by the start of the run in progress. Steady for the whole answer,
 * and a chat that has not been told it is running yet falls back to the time it
 * was opened, which is also not going to move.
 *
 * @param {TabInfo[]} tabs
 * @returns {TabInfo[]}
 */
export function byRun(tabs) {
  return tabs.slice().sort((left, right) => started(right) - started(left) || left.id.localeCompare(right.id));
}

/** @param {TabInfo} tab */
function started(tab) {
  return Number(tab.runStartedMs) || Number(tab.createdMs) || 0;
}

/**
 * The moment a chat last did something worth moving it up for.
 *
 * @param {TabInfo} tab
 */
export function stamp(tab) {
  return Math.max(Number(tab.lastOutputMs) || 0, Number(tab.finishedMs) || 0, Number(tab.createdMs) || 0);
}

/**
 * A finished run nobody has looked at: it ended after the last time the reader
 * opened this chat, and they are not in it right now.
 *
 * @param {TabInfo} tab
 * @param {Record<string, number>} seen
 * @param {string | null} active
 */
export function isUnread(tab, seen, active) {
  if (tab.running || tab.id === active) return false;
  const ended = Number(tab.finishedMs) || 0;
  return ended > (Number(seen[tab.id]) || 0);
}
