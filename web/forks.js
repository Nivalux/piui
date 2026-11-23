// @ts-check

/**
 * A chat as far as lineage is concerned: where it is, and where it came from.
 *
 * @typedef {{id: string, path: string, parent?: string | null, created?: string | null, title: string}} Chat
 */

/**
 * What each chat knows about its own origin, keyed by session path.
 *
 * @param {Chat[]} chats
 * @returns {Map<string, {of: string, mark: string}>} the chat forked from, plus `#2` numbering
 *   among the forks of one chat, oldest first.
 */
export function lineage(chats) {
  const known = new Map();
  for (const chat of chats) {
    known.set(chat.path, chat);
    known.set(chat.id, chat);
  }

  /** @type {Map<string, Chat[]>} */
  const siblings = new Map();
  for (const chat of chats) {
    if (!chat.parent) continue;
    const list = siblings.get(chat.parent);
    if (list) list.push(chat);
    else siblings.set(chat.parent, [chat]);
  }

  /** @type {Map<string, {of: string, mark: string}>} */
  const found = new Map();
  for (const [parent, list] of siblings) {
    const origin = originOf(known.get(parent), parent);
    list.sort(byBirth);
    const numbered = list.length > 1;
    for (const [index, chat] of list.entries()) {
      found.set(chat.path, { of: origin, mark: numbered ? `#${index + 1}` : "" });
    }
  }
  return found;
}

/**
 * Oldest first, so the first fork of a chat keeps `#1` no matter how the list was ordered.
 *
 * @param {Chat} left
 * @param {Chat} right
 */
function byBirth(left, right) {
  return String(left.created ?? "").localeCompare(String(right.created ?? "")) || left.path.localeCompare(right.path);
}

/**
 * The chat a fork came from: by name while it is still listed, by short id once it is gone.
 *
 * @param {Chat | undefined} parent
 * @param {string} path
 */
function originOf(parent, path) {
  if (parent) return parent.title;
  const id = sessionId(path);
  return `gone chat ${id.slice(0, 8)}`;
}

/**
 * `<timestamp>_<id>.jsonl` → `<id>`, the way Pi names its files.
 *
 * @param {string} path
 */
function sessionId(path) {
  const base = path.split("/").pop() ?? path;
  const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  const cut = stem.lastIndexOf("_");
  return cut >= 0 ? stem.slice(cut + 1) : stem;
}
