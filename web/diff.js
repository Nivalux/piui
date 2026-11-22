// @ts-check

/**
 * Diffs.
 *
 * @typedef {"add" | "del" | "ctx" | "hunk" | "meta"} RowKind
 * @typedef {{kind: RowKind, old: number | null, new: number | null, text: string}} Row
 * @typedef {{header: string, rows: Row[]}} Hunk
 * @typedef {{
 *   path: string,
 *   header: string,
 *   hunks: Hunk[],
 *   adds: number,
 *   dels: number,
 *   binary: boolean,
 *   patch: string,
 * }} FileDiff
 *
 * @param {string} text
 * @returns {FileDiff[]}
 */
export function parseDiff(text) {
  const files = /** @type {FileDiff[]} */ ([]);
  /** @type {FileDiff | null} */
  let file = null;
  /** @type {Hunk | null} */
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  /** @param {string} line */
  const row = (line) => {
    if (!file) return;
    if (!hunk) {
      hunk = { header: "", rows: [] };
      file.hunks.push(hunk);
    }
    hunk.rows.push(classify(line, oldLine, newLine));
    if (line.startsWith("+") && !line.startsWith("+++")) newLine += 1;
    if (line.startsWith("-") && !line.startsWith("---")) oldLine += 1;
    if (line.startsWith(" ") || line === "") {
      oldLine += 1;
      newLine += 1;
    }
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = {
        path: pathFromGitLine(line),
        header: "",
        hunks: [],
        adds: 0,
        dels: 0,
        binary: false,
        patch: "",
      };
      hunk = null;
      files.push(file);
      continue;
    }

    if (!file && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      file = { path: "", header: "", hunks: [], adds: 0, dels: 0, binary: false, patch: "" };
      hunk = null;
      files.push(file);
    }

    if (!file) continue;

    if (line.startsWith("@@")) {
      const counts = readHunkHeader(line);
      oldLine = counts.old;
      newLine = counts.new;
      hunk = { header: line, rows: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (line.startsWith("Binary files ")) {
      file.binary = true;
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line.startsWith("+++ ")) {
        file.header = line.slice(4).replace(/^b\//, "");
        if (file.path.length === 0) file.path = file.header;
      }
      continue;
    }

    if (
      line.startsWith("index ") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ")
    ) {
      continue;
    }

    row(line);
  }

  for (const entry of files) {
    for (const hunk of entry.hunks) {
      for (const line of hunk.rows) {
        if (line.kind === "add") entry.adds += 1;
        if (line.kind === "del") entry.dels += 1;
      }
    }
    entry.patch = patchOf(text, entry.path);
    if (!entry.header) entry.header = entry.path;
  }

  return files.filter((entry) => entry.path.length > 0);
}

/**
 * The patch text of one file, for a copy button that hands over something you can feed back to
 * `git apply`.
 *
 * @param {string} text full diff
 * @param {string} path
 * @returns {string}
 */
export function patchOf(text, path) {
  const out = /** @type {string[]} */ ([]);
  let mine = false;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      mine = pathFromGitLine(line) === path;
    }
    if (mine) out.push(line);
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return `${out.join("\n")}\n`;
}

/**
 * @param {string} line
 * @param {number} oldLine
 * @param {number} newLine
 * @returns {Row}
 */
function classify(line, oldLine, newLine) {
  if (line.startsWith("@@")) return { kind: "hunk", old: null, new: null, text: line };
  if (line.startsWith("\\")) return { kind: "meta", old: null, new: null, text: line.slice(1) };
  if (line.startsWith("+")) return { kind: "add", old: null, new: newLine, text: line.slice(1) };
  if (line.startsWith("-")) return { kind: "del", old: oldLine, new: null, text: line.slice(1) };
  return { kind: "ctx", old: oldLine, new: newLine, text: line.startsWith(" ") ? line.slice(1) : line };
}

/**
 * `@@ -12,7 +12,9 @@ title` → the first line number on each side.
 *
 * @param {string} line
 * @returns {{old: number, new: number}}
 */
export function readHunkHeader(line) {
  const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return { old: 0, new: 0 };
  return { old: Number(match[1]), new: Number(match[2]) };
}

/**
 * `diff --git a/src/a.go b/src/b.go` → the b side, which is where the file lives
 * now. Renames and paths with spaces both land here, so the split is on the
 * common ` b/` marker rather than on whitespace.
 *
 * @param {string} line
 * @returns {string}
 */
export function pathFromGitLine(line) {
  const prefix = "diff --git a/";
  if (!line.startsWith(prefix)) return "";

  const rest = line.slice(prefix.length);
  const marker = rest.lastIndexOf(" b/");
  if (marker < 0) return "";

  const path = rest.slice(marker + 3);
  return path.replace(/\/dev\/null$/, "");
}

/** Cells the exact dynamic programming is willing to spend on one comparison. */
const cellBudget = 400_000;

/**
 * A file ending in a newline has no empty line after its last one, so the split
 * must not invent one — otherwise every write counts a line it never added.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function linesOf(text) {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Diff two versions of the same text without a patch in between, producing the
 * same rows a git hunk produces. Long files that exceed the cell budget fall
 * back to "everything removed, everything added" rather than hanging.
 *
 * @param {string} before
 * @param {string} after
 * @returns {Row[]}
 */
export function diffLines(before, after) {
  const oldLines = linesOf(before);
  const newLines = linesOf(after);

  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;

  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  /** @type {Row[]} */
  const rows = [];
  for (let index = 0; index < head; index += 1) {
    rows.push({ kind: "ctx", old: index + 1, new: index + 1, text: oldLines[index] });
  }

  const removed = oldLines.slice(head, oldLines.length - tail);
  const added = newLines.slice(head, newLines.length - tail);
  rows.push(...align(removed, added, head + 1));

  for (let index = 0; index < tail; index += 1) {
    const from = oldLines.length - tail + index;
    rows.push({ kind: "ctx", old: from + 1, new: newLines.length - tail + index + 1, text: oldLines[from] });
  }
  return rows;
}

/**
 * Count what a set of rows changes.
 *
 * @param {Row[]} rows
 * @returns {{adds: number, dels: number}}
 */
export function countRows(rows) {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.kind === "add") adds += 1;
    if (row.kind === "del") dels += 1;
  }
  return { adds, dels };
}

/**
 * Keep a few unchanged lines around every change and collapse the rest, so a
 * one line change in a thousand line file stays readable.
 *
 * @param {Row[]} rows
 * @param {number} [keep]
 * @returns {Row[]}
 */
export function shrink(rows, keep = 3) {
  const touched = new Set();
  for (const [index, row] of rows.entries()) {
    if (row.kind !== "ctx" && row.kind !== "hunk") {
      for (let offset = -keep; offset <= keep; offset += 1) touched.add(index + offset);
    }
  }

  /** @type {Row[]} */
  const kept = [];
  let skipped = 0;
  for (const [index, row] of rows.entries()) {
    if (touched.has(index)) {
      if (skipped > 0) {
        kept.push({ kind: "hunk", old: null, new: null, text: `⋯ ${skipped} unchanged` });
        skipped = 0;
      }
      kept.push(row);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) kept.push({ kind: "hunk", old: null, new: null, text: `⋯ ${skipped} unchanged` });
  return kept;
}

/**
 * @param {string[]} removed
 * @param {string[]} added
 * @param {number} first  one-based line number where both sides start
 * @returns {Row[]}
 */
function align(removed, added, first) {
  if (removed.length === 0) {
    return added.map((text, index) => /** @type {Row} */ ({ kind: "add", old: null, new: first + index, text }));
  }
  if (added.length === 0) {
    return removed.map((text, index) => /** @type {Row} */ ({ kind: "del", old: first + index, new: null, text }));
  }
  if (removed.length * added.length > cellBudget) {
    return [
      ...removed.map((text, index) => /** @type {Row} */ ({ kind: "del", old: first + index, new: null, text })),
      ...added.map((text, index) => /** @type {Row} */ ({ kind: "add", old: null, new: first + index, text })),
    ];
  }

  const width = added.length + 1;
  const table = new Uint32Array((removed.length + 1) * width);
  for (let i = removed.length - 1; i >= 0; i -= 1) {
    for (let j = added.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        removed[i] === added[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  /** @type {Row[]} */
  const rows = [];
  let i = 0;
  let j = 0;
  let old = first;
  let next = first;
  while (i < removed.length && j < added.length) {
    if (removed[i] === added[j]) {
      rows.push({ kind: "ctx", old: old++, new: next++, text: removed[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push({ kind: "del", old: old++, new: null, text: removed[i] });
      i += 1;
    } else {
      rows.push({ kind: "add", old: null, new: next++, text: added[j] });
      j += 1;
    }
  }
  while (i < removed.length) {
    rows.push({ kind: "del", old: old++, new: null, text: removed[i] });
    i += 1;
  }
  while (j < added.length) {
    rows.push({ kind: "add", old: null, new: next++, text: added[j] });
    j += 1;
  }
  return rows;
}
