// @ts-check

/**
 * The order of the sidebar, and which chats are still waiting to be read.
 *
 * Working chats lead, settled ones follow, and inside each group the chat that
 * did something most recently comes first. A run that ended while the reader
 * was somewhere else stays marked until they look at it.
 *
 * @typedef {import("./protocol.js").TabInfo} TabInfo
 */

/**
 * @param {TabInfo[]} tabs
 * @returns {{working: TabInfo[], settled: TabInfo[]}}
 */
export function splitTabs(tabs) {
  return { working: byActivity(tabs.filter((tab) => tab.running)), settled: byActivity(tabs.filter((tab) => !tab.running)) };
}

/**
 * @param {TabInfo[]} tabs
 * @returns {TabInfo[]}
 */
export function byActivity(tabs) {
  return tabs.slice().sort((left, right) => stamp(right) - stamp(left));
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
