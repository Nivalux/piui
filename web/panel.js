// @ts-check
/**
 * What the side panel offers and what the main area shows.
 *
 * The panel lists files and the diff; both are a way to get somewhere else, so
 * the interesting part is the reducer behind a click: a file opens as a view
 * next to the chat, opening the same file twice focuses the view that is
 * already there, and closing one leaves the reader where they were looking.
 */

import { rank } from "./filter.js";

/**
 * What the main area can hold. A file and the patch of that file are two views:
 * one is what it is, the other is what changed.
 */
/**
 * `preview` marks a view that was only glanced at: it holds the slot until the
 * next glance replaces it, and it is the one thing a click on the tab settles.
 */
/** @typedef {{kind: "chat"}} ChatView */
/** @typedef {{kind: "file", path: string, preview?: boolean}} FileView */
/** @typedef {{kind: "diff", path: string, preview?: boolean}} DiffView */
/** @typedef {ChatView | FileView | DiffView} View */

/** @typedef {{path: string, dir: string, name: string, ranges: [number, number][]}} FileRow */
/** @typedef {{name: string, path: string, count: number}} DirRow */

/** @typedef {{path: string, display: string, status: string, staged?: boolean, untracked?: boolean}} Changed */

/** @param {string} path @returns {string} */
export function baseOf(path) {
  const text = String(path);
  const at = text.lastIndexOf("/");
  return at < 0 ? text : text.slice(at + 1);
}

/** @param {string} path @returns {string} */
export function dirOf(path) {
  const text = String(path);
  const at = text.lastIndexOf("/");
  return at < 0 ? "" : text.slice(0, at);
}

/**
 * The Files tab while a query is typed: rows anywhere in the tree, best first,
 * capped so a huge repository still paints. A row says which folder it came
 * from, because a search leaves the folder you were looking at.
 *
 * @param {{path: string}[]} files
 * @param {string} query
 * @param {number} [limit]
 * @returns {FileRow[]}
 */
export function fileRows(files, query, limit = 400) {
  /** @type {(file: {path: string}) => string[]} */
  const haystack = query.includes("/") ? (file) => [file.path] : (file) => [baseOf(file.path)];
  const hits = rank(query, files, haystack);
  if (query.trim().length === 0) return hits.slice(0, limit).map(rowOf);

  return hits
    .sort(
      (left, right) =>
        right.score - left.score || depth(left.item.path) - depth(right.item.path) || left.item.path.localeCompare(right.item.path),
    )
    .slice(0, limit)
    .map(rowOf);
}

/** @param {{item: {path: string}, ranges: [number, number][]}} hit @returns {FileRow} */
function rowOf(hit) {
  return {
    path: hit.item.path,
    dir: dirOf(hit.item.path),
    name: baseOf(hit.item.path),
    ranges: hit.ranges,
  };
}

/**
 * How far below the project root a file sits; the shallower one is the closer
 * read, so typing three letters brings the file you meant before the copy of it
 * buried in a vendor folder.
 *
 * @param {string} path
 */
function depth(path) {
  let seen = 0;
  for (const char of path) if (char === "/") seen += 1;
  return seen;
}

/**
 * One folder of the tree: what sits directly under `dir`, folders before files.
 * A folder carries how much is below it, which is how a reader tells a dead end
 * from a deep one before opening either.
 *
 * @param {{path: string}[]} files
 * @param {string} dir "" for the project root
 * @param {number} [limit]
 * @returns {{dirs: DirRow[], files: {name: string, path: string}[]}}
 */
export function fileTree(files, dir, limit = 400) {
  const prefix = dir === "" ? "" : `${dir}/`;
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {{name: string, path: string}[]} */
  const here = [];

  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    if (rest.length === 0) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      here.push({ name: rest, path: file.path });
      continue;
    }
    const name = rest.slice(0, slash);
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }

  return {
    dirs: [...seen]
      .map(([name, count]) => ({ name, path: prefix + name, count }))
      .sort(byName)
      .slice(0, limit),
    files: here.sort(byName).slice(0, limit),
  };
}

/**
 * The folders a path runs through, outermost first, for the bar above the list.
 *
 * @param {string} dir
 * @returns {{name: string, path: string}[]}
 */
export function trailOf(dir) {
  if (dir === "") return [];
  const parts = dir.split("/");
  return parts.map((name, at) => ({ name, path: parts.slice(0, at + 1).join("/") }));
}

/** @param {{name: string}} a @param {{name: string}} b */
function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Open a view beside the chat. The same view is focused rather than opened
 * twice, so clicking a file in both tabs of the panel cannot stack copies. A
 * preview takes the slot another preview was holding.
 *
 * @param {View[]} views
 * @param {number} active
 * @param {FileView | DiffView} view
 * @param {boolean} [preview]
 * @returns {{views: View[], active: number}}
 */
export function openView(views, active, view, preview = false) {
  const at = views.findIndex((other) => other.kind !== "chat" && other.kind === view.kind && other.path === view.path);
  if (at >= 0) return { views, active: at };

  const slot = preview ? views.findIndex(isPreview) : -1;
  if (slot >= 0) {
    const next = views.slice();
    next[slot] = { ...view, preview: true };
    return { views: next, active: slot };
  }

  return { views: [...views, preview ? { ...view, preview: true } : view], active: views.length };
}

/**
 * Stop previewing a view. From here it is a tab of its own, and the next file
 * clicked in the panel opens beside it instead of over it.
 *
 * @param {View[]} views
 * @param {number} at
 * @returns {{views: View[], active: number}}
 */
export function pinView(views, at) {
  const view = views[at];
  if (view === undefined || view.kind === "chat" || view.preview !== true) return { views, active: at };
  const next = views.slice();
  next[at] = { ...view, preview: false };
  return { views: next, active: at };
}

/** @param {View | undefined} view */
function isPreview(view) {
  return view !== undefined && view.kind !== "chat" && view.preview === true;
}

/** @param {View[]} views @param {number} active @param {string} path @param {boolean} [preview] */
export function openFile(views, active, path, preview = false) {
  return openView(views, active, { kind: "file", path }, preview);
}

/** @param {View[]} views @param {number} active @param {string} path @param {boolean} [preview] */
export function openDiff(views, active, path, preview = false) {
  return openView(views, active, { kind: "diff", path }, preview);
}

/**
 * `git status` in the three blocks it is written in. A base other than the
 * working tree reports every file as staged, and then the headings would all
 * say the same thing, so they are left out.
 *
 * @param {Changed[]} files
 * @returns {{title: string, files: Changed[]}[]}
 */
export function statusGroups(files) {
  const groups = [
    { title: "staged", files: files.filter((file) => file.staged) },
    { title: "changes", files: files.filter((file) => !file.staged && !file.untracked) },
    { title: "untracked", files: files.filter((file) => file.untracked) },
  ].filter((group) => group.files.length > 0);

  return groups.length > 1 ? groups : [{ title: "", files }];
}

/**
 * Close a view. The chat at index 0 is not closable: it is the thing the panel
 * and the composer belong to.
 *
 * @param {View[]} views
 * @param {number} active
 * @param {number} index
 * @returns {{views: View[], active: number}}
 */
export function closeFile(views, active, index) {
  if (index <= 0 || index >= views.length) return { views, active };
  const kept = views.filter((_, at) => at !== index);
  return { views: kept, active: Math.min(active > index ? active - 1 : active, kept.length - 1) };
}

/**
 * The file view shows line numbers, so the text arrives as lines. A trailing
 * newline is the end of the file, not an empty line after it.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {{lines: {n: number, value: string}[], rest: number}}
 */
export function numberLines(text, limit = 2000) {
  const lines = String(text).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return {
    lines: lines.slice(0, limit).map((value, at) => ({ n: at + 1, value })),
    rest: Math.max(0, lines.length - limit),
  };
}
