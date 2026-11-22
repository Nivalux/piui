/**
 * Text shaping for the parts of the UI that show numbers and paths. Pure, so `node --test` can pin
 * the wording without a browser.
 *
 * @param {string} path
 * @returns {string}
 */
export function basename(path) {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? /** @type {string} */ (parts.at(-1)) : path;
}

/**
 * Shorten on a character boundary so an ellipsis never splits an emoji.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = Array.from(text.slice(0, max + 1));
  const kept = cut.slice(0, max).join("");
  return `${kept.trimEnd()}…`;
}

/**
 * How full a context window is, as the three things a footer needs: how far to
 * draw the arc, what to say, and how much to shout. Nothing at all comes back
 * when either number is missing, because a ring around no information would be
 * a lie with better manners.
 *
 * @param {number | null | undefined} used
 * @param {number | null | undefined} size
 * @returns {{fraction: number, percent: number, label: string, tone: "" | "warm" | "critical"}}
 */
export function contextRing(used, size) {
  /** @type {{fraction: number, percent: number, label: string, tone: "" | "warm" | "critical"}} */
  const quiet = { fraction: 0, percent: 0, label: "", tone: "" };
  if (!Number.isFinite(used) || !Number.isFinite(size) || (used ?? 0) < 0 || (size ?? 0) <= 0) return quiet;

  const fraction = Math.min(1, (used ?? 0) / (size ?? 1));
  const percent = Math.round(fraction * 100);
  /** @type {"" | "warm" | "critical"} */
  const tone = percent >= 90 ? "critical" : percent >= 70 ? "warm" : "";
  return { fraction, percent, label: `${tokens(used ?? 0)} / ${tokens(size ?? 0)}`, tone };
}

/**
 * A tool hint cut into pieces the page can colour: the counts of added and removed lines wear the
 * diff colours, the rest stays neutral.
 *
 * @param {string} text
 * @returns {Array<{text: string, kind: "" | "add" | "del"}>}
 */
export function hintParts(text) {
  /** @type {Array<{text: string, kind: "" | "add" | "del"}>} */
  const parts = [];
  let rest = text;
  while (rest.length > 0) {
    const at = rest.search(/[+−]\d/);
    if (at < 0) {
      parts.push({ text: rest, kind: "" });
      break;
    }
    if (at > 0) parts.push({ text: rest.slice(0, at), kind: "" });
    const match = /^[+−]\d+/.exec(rest.slice(at))?.[0] ?? rest[at];
    parts.push({ text: match, kind: match.startsWith("+") ? "add" : "del" });
    rest = rest.slice(at + match.length);
  }
  return parts;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function firstLine(text) {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim();
}

/**
 * The last line with anything on it. A thought still arriving is read from the bottom, so the
 * summary keeps moving.
 *
 * @param {string} text
 * @returns {string}
 */
export function lastLine(text) {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim().length > 0) return lines[index].trim();
  }
  return "";
}

/**
 * "820ms", "3.2s", "1m 04s", "2h 07m" – whatever fits a footer.
 *
 * @param {number} ms
 * @returns {string}
 */
export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * A duration in one word: "12s", "35m", "4h", "6d". A sidebar has no room for
 * "1h 05m", and nobody needs the minutes once it has been days.
 *
 * @param {number} ms
 * @returns {string}
 */
export function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * A wall clock for the log, in whatever zone the browser claims.
 *
 * @param {string | null | undefined} stamp
 * @returns {string}
 */
export function time(stamp) {
  if (!stamp) return "";
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toTimeString().slice(0, 8);
}

/**
 * When a session last moved. `now` is a parameter so a test can freeze it.
 *
 * @param {string | number | null | undefined} stamp ISO 8601 or epoch milliseconds
 * @param {number} now epoch milliseconds
 * @returns {string}
 */
export function relativeTime(stamp, now) {
  if (stamp === null || stamp === undefined) return "—";
  const at = typeof stamp === "number" ? stamp : Date.parse(stamp);
  if (!Number.isFinite(at)) return "—";

  const delta = now - at;
  if (delta < 0) return "now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const date = new Date(at);
  const thisYear = new Date(now).getFullYear();
  const month = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return date.getFullYear() === thisYear ? month : `${month} ${date.getFullYear()}`;
}

/**
 * Token counts are read as "12k", not "12480".
 *
 * @param {number} count
 * @returns {string}
 */
export function tokens(count) {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Byte counts read the way a file listing says them.
 *
 * @param {number} count
 * @returns {string}
 */
export function bytes(count) {
  if (!Number.isFinite(count) || count <= 0) return "0 B";
  if (count < 1024) return `${Math.round(count)} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} kB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {number} value
 * @returns {string}
 */
export function cost(value) {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * The number the composer footer shows while a run streams.
 *
 * @param {number} perSecondValue
 * @returns {string}
 */
export function perSecond(perSecondValue) {
  if (!Number.isFinite(perSecondValue) || perSecondValue <= 0) return "— t/s";
  if (perSecondValue < 10) return `${perSecondValue.toFixed(1)} t/s`;
  return `${Math.round(perSecondValue)} t/s`;
}

/**
 * One line describing a tool call: the argument a human would recognise, not the
 * whole JSON. `bash` shows its command, the file tools their path.
 *
 * @param {string} toolName
 * @param {unknown} args
 * @returns {string}
 */
export function toolSummary(toolName, args) {
  const record = typeof args === "object" && args !== null ? /** @type {Record<string, unknown>} */ (args) : {};

  const command = record.command;
  if (typeof command === "string" && command.trim().length > 0) return truncate(firstLine(command), 90);

  const needle = record.pattern ?? record.query ?? record.url;
  if (typeof needle === "string" && needle.trim().length > 0) return truncate(firstLine(needle), 90);

  const file = record.path ?? record.file ?? record.notebook_path;
  if (typeof file === "string" && file.trim().length > 0) {
    const edits = Array.isArray(record.edits) ? record.edits.length : 0;
    return edits > 0 ? `${truncate(firstLine(file), 80)} · ${edits} edits` : truncate(firstLine(file), 90);
  }

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim().length > 0) return `${key}: ${truncate(firstLine(value), 90)}`;
    if (typeof value === "number" || typeof value === "boolean") return `${key}: ${String(value)}`;
  }

  return toolName;
}

/**
 * The tail of a folder path. The leaf is the part anyone recognises, so the
 * head is what gets dropped.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function shortPath(cwd) {
  const parts = cwd.split("/").filter((part) => part.length > 0);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * Two letters of the folder, so a stack of chats is scannable without reading
 * any of them. A scratch chat has no folder and says so.
 *
 * @param {string} cwd
 * @param {boolean} [project]
 * @returns {string}
 */
export function badge(cwd, project = true) {
  if (!project) return "··";
  const letters = basename(cwd)
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 2)
    .toUpperCase();
  return letters.length > 0 ? letters : "··";
}

/**
 * Output of a tool, cut down to what fits a collapsed row.
 *
 * @param {string} text
 * @param {number} [lines]
 * @returns {string}
 */
export function preview(text, lines = 6) {
  const kept = text.split("\n").slice(0, lines).join("\n");
  return text.split("\n").length > lines ? `${kept}\n…` : kept;
}
