// @ts-check

/**
 * Tool views.
 *
 * The tools Pi reaches for are known here, so their arguments and results get
 * shaped instead of dumped: a read says which range it covered, a write shows a
 * diff, a job shows status, exit code and log path as chips. Anything else keeps
 * the plain argument and result dump.
 */

import { bytes, firstLine, truncate } from "./format.js";
import { countRows, diffLines, linesOf, parseDiff, shrink } from "./diff.js";

/**
 * @typedef {import("./diff.js").Row} Row
 * @typedef {{label: string, value: string}} Chip
 * @typedef {{
 *   hint: string,
 *   chips: Chip[],
 *   input: Chip[],
 *   command: string,
 *   text: string,
 *   rows: Row[] | null,
 *   adds: number,
 *   dels: number,
 * }} ToolView
 */

/**
 * @param {string} name
 * @param {Record<string, unknown> | null | undefined} args
 * @param {string} text flattened result
 * @param {unknown} details tool specific result details
 * @param {string | null} [before] content of the same path before this call
 * @returns {ToolView}
 */
export function toolView(name, args, text, details, before = null) {
  const given = args ?? {};
  switch (name) {
    case "read":
      return readTool(given, text);
    case "write":
      return writeTool(given, text, before);
    case "edit":
      return editTool(given, text, details);
    case "bash":
      return shellTool(given, text);
    case "job_run":
      return jobTool(given, text, details, ["command"]);
    case "job_wait":
      return jobTool(given, text, details, ["job"]);
    default:
      return { hint: "", chips: [], input: rest(given, []), command: "", text, rows: null, adds: 0, dels: 0 };
  }
}

/**
 * Whether a tool has anything shaped for it.
 *
 * @param {string} name
 */
export function isKnownTool(name) {
  return ["read", "write", "edit", "bash", "job_run", "job_wait"].includes(name);
}

/** @param {Record<string, unknown>} args @param {string} text */
function readTool(args, text) {
  const lines = text.length === 0 ? [] : text.split("\n");
  const from = number(args.offset) ?? 1;
  const to = from + Math.max(lines.length - 1, 0);
  const chips = [];
  if (lines.length > 0) chips.push({ label: "lines", value: `${from}–${to}` });
  if (args.limit !== undefined && args.limit !== null) chips.push({ label: "limit", value: String(args.limit) });

  return {
    hint: lines.length === 0 ? "empty" : `${lines.length} lines`,
    chips: [{ label: "path", value: String(args.path ?? "") }, ...chips],
    input: rest(args, ["path", "offset", "limit"]),
    command: "",
    text,
    rows: null,
    adds: 0,
    dels: 0,
  };
}

/** @param {Record<string, unknown>} args @param {string} text @param {string | null} before */
function writeTool(args, text, before) {
  const content = String(args.content ?? "");
  const lines = linesOf(content);
  /** @type {Row[]} */
  const full =
    before === null
      ? lines.map((line, index) => ({ kind: "add", old: null, new: index + 1, text: line }))
      : diffLines(before, content);
  const { adds, dels } = countRows(full);

  return {
    hint: `+${adds} −${dels}`,
    chips: [
      { label: "path", value: String(args.path ?? "") },
      { label: "size", value: bytes(content.length) },
    ],
    input: rest(args, ["path", "content"]),
    command: "",
    text: content,
    rows: shrink(full),
    adds,
    dels,
  };
}

/** @param {Record<string, unknown>} args @param {string} text @param {unknown} details */
function editTool(args, text, details) {
  const given = /** @type {Record<string, unknown>} */ (details ?? {});
  const patch = typeof given.patch === "string" ? given.patch : "";
  const files = patch.length > 0 ? parseDiff(patch) : [];
  /** @type {Row[]} */
  const rows = files.flatMap((file) =>
    file.hunks.flatMap((hunk) => [{ kind: "hunk", old: null, new: null, text: hunk.header }, ...hunk.rows]),
  );
  const adds = files.reduce((total, file) => total + file.adds, 0);
  const dels = files.reduce((total, file) => total + file.dels, 0);
  const edits = Array.isArray(args.edits) ? args.edits.length : 0;

  return {
    hint: rows.length > 0 ? `+${adds} −${dels}` : `${edits} edit${edits === 1 ? "" : "s"}`,
    chips: [
      { label: "path", value: String(args.path ?? "") },
      ...(edits > 0 ? [{ label: "edits", value: String(edits) }] : []),
    ],
    input: rest(args, ["path", "edits"]),
    command: "",
    text,
    rows: rows.length > 0 ? rows : null,
    adds,
    dels,
  };
}

/** @param {Record<string, unknown>} args @param {string} text */
function shellTool(args, text) {
  const lines = text.length === 0 ? [] : text.split("\n");
  return {
    hint: lines.length > 1 ? `${lines.length} lines` : "",
    chips: [],
    input: rest(args, ["command"]),
    command: cutOff(args, "command"),
    text,
    rows: null,
    adds: 0,
    dels: 0,
  };
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} text
 * @param {unknown} details
 * @param {string[]} inTitle argument the row already shows as its title
 */
function jobTool(args, text, details, inTitle) {
  const given = /** @type {Record<string, unknown>} */ (details ?? {});
  const status = String(given.status ?? "");
  const code = given.exitCode === undefined || given.exitCode === null ? null : Number(given.exitCode);
  const chips = [];

  if (status.length > 0) chips.push({ label: "status", value: status });
  if (code !== null) chips.push({ label: "exit", value: String(code) });
  if (given.elapsedSec !== undefined && given.elapsedSec !== null) {
    chips.push({ label: "elapsed", value: `${Number(given.elapsedSec).toFixed(1)}s` });
  }
  if (given.pid) chips.push({ label: "pid", value: String(given.pid) });
  if (given.job) chips.push({ label: "job", value: String(given.job) });
  if (given.logPath) chips.push({ label: "log", value: String(given.logPath) });

  // No result yet means pi has not reported anything: the row already says
  // "running", so inventing a status here would be a lie about the job.
  const hint = code === null ? status : `${status || "exited"} ${code}`;
  return {
    hint,
    chips,
    input: rest(args, inTitle),
    command: cutOff(args, "command"),
    text: jobBody(text),
    rows: null,
    adds: 0,
    dels: 0,
  };
}

/**
 * The whole of an argument the summary line had to cut short. A row shows one
 * line of at most ninety characters, and everything past that would exist
 * nowhere else once the call is opened.
 *
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @returns {string}
 */
function cutOff(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) return "";
  return truncate(firstLine(value), 90) === value ? "" : value;
}

/**
 * What the call was given beyond the pieces the row shows anyway. A tool that
 * is opened mid-run should say everything it was told, not only the one
 * argument that fitted the summary line.
 *
 * @param {Record<string, unknown>} args
 * @param {string[]} shown
 * @returns {Chip[]}
 */
function rest(args, shown) {
  /** @type {Chip[]} */
  const out = [];
  for (const [key, value] of Object.entries(args)) {
    if (shown.includes(key) || value === undefined || value === null || value === "") continue;
    out.push({ label: key, value: describe(value) });
  }
  return out;
}

/** @param {unknown} value */
function describe(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const headerLine = /^(status:|elapsed .*· pid |log \/|job_wait \{)/;

/**
 * The first lines of a job result repeat what the chips already say.
 *
 * @param {string} text
 */
export function jobBody(text) {
  const lines = text.split("\n");
  let kept = 0;
  while (kept < lines.length && headerLine.test(lines[kept])) kept += 1;
  const rest = lines.slice(kept).join("\n").replace(/^\n+/, "");
  return rest.length > 0 ? rest : text;
}

/** @param {unknown} value */
function number(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
