// @ts-check

/** The cursor of the folder picker. */

import { rank } from "./filter.js";

/**
 * The row a list lands on after `delta` steps, wrapping at both ends. A list with no rows has no
 * cursor at all, which is `-1`.
 *
 * @param {number} length
 * @param {number} cursor
 * @param {number} delta
 * @returns {number}
 */
export function step(length, cursor, delta) {
  if (length <= 0) return -1;
  if (cursor < 0) return delta < 0 ? length - 1 : 0;
  const moved = (cursor + delta) % length;
  return moved < 0 ? moved + length : moved;
}

/**
 * Splits a path being typed into the directory to list and the words to filter its folders with. A
 * path always ends at a slash, so typing continues a name; a field without one is a search of the
 * filesystem root.
 *
 * @param {string} value
 * @returns {{base: string, needle: string}}
 */
export function splitTyping(value) {
  const text = String(value);
  const cut = text.lastIndexOf("/");
  if (cut < 0) return { base: "/", needle: text };
  return { base: text.slice(0, cut) || "/", needle: text.slice(cut + 1) };
}

/**
 * The folders the list shows: everything typed reaches, best first, an empty needle keeping the
 * order the server sent.
 *
 * @param {{name: string, path: string}[]} dirs
 * @param {string} needle
 * @returns {{item: {name: string, path: string}, score: number, ranges: [number, number][]}[]}
 */
export function suggestions(dirs, needle) {
  return rank(needle, dirs, (dir) => [dir.name, dir.path]);
}

/**
 * The path a keystroke means. A highlighted row wins; otherwise it is what stands in the field,
 * without the slash that only marks it as a folder.
 *
 * @param {{path: string}[]} rows
 * @param {number} cursor
 * @param {string} typed
 * @returns {string}
 */
export function chosen(rows, cursor, typed) {
  if (cursor >= 0 && cursor < rows.length) return rows[cursor].path;
  const value = String(typed).trim().replace(/\/+$/, "");
  return value.length > 0 ? value : "/";
}
