// @ts-check

/**
 * The `/` palette.
 *
 * @typedef {import("./protocol.js").Command} Command
 *
 * @typedef {{query: string}} SlashQuery
 *
 * @typedef {{name: string, description?: string, argumentHint?: string, run: string}} Known
 *   `run`: `pi` sends the line to pi as a prompt, a command type goes down the pipe as that RPC
 *   command, a word names something this page does itself, an empty one a screen of pi's own.
 */
export const limit = 12;

/** Pi's own commands, which its RPC pipe neither reports nor runs. */
export const builtins = /** @type {Known[]} */ ([
  { name: "reload", description: "Reopen this chat so pi reads its resources again", run: "reload" },
  { name: "compact", description: "Compact the context now", argumentHint: "<what to keep>", run: "compact" },
  { name: "model", description: "Select a model", argumentHint: "<provider/model>", run: "model" },
  { name: "thinking", description: "Set the thinking level", argumentHint: "<level>", run: "thinking" },
  { name: "copy", description: "Copy the last answer to the clipboard", run: "copy" },
  { name: "new", description: "Start a fresh session in this tab", run: "new_session" },
  { name: "clone", description: "Duplicate this chat at where it stands", run: "clone" },
  { name: "name", description: "Set the display name of the chat", argumentHint: "<name>", run: "set_session_name" },
  { name: "export", description: "Export the chat as HTML", argumentHint: "<path>", run: "export_html" },
  { name: "session", description: "Show what this chat has used", run: "session" },
  { name: "resume", description: "Open another session", run: "resume" },
  { name: "quit", description: "Close this chat", run: "quit" },
  { name: "fork", description: "Fork from a previous user message", run: "fork" },
  { name: "settings", description: "Open the settings menu", run: "" },
  { name: "tree", description: "Navigate the session tree", run: "" },
  { name: "scoped-models", description: "Enable or disable models for Ctrl+P cycling", run: "" },
  { name: "import", description: "Import a JSONL session", run: "" },
  { name: "share", description: "Share the session as an artifact or a gist", run: "" },
  { name: "bug", description: "Report a bug to the pi developers", argumentHint: "<description>", run: "" },
  { name: "changelog", description: "Show the changelog", run: "" },
  { name: "hotkeys", description: "Show the keyboard shortcuts", run: "" },
  { name: "trust", description: "Save the project trust decision", run: "" },
  { name: "login", description: "Configure a provider's authentication", argumentHint: "<provider>", run: "" },
  { name: "logout", description: "Remove a provider's authentication", run: "" },
]);

/**
 * What the palette offers: pi's own commands first, then the built-ins pi did not report.
 *
 * @param {Command[]} reported
 * @returns {Known[]}
 */
export function knownCommands(reported) {
  const fromPi = reported.map((command) => ({ ...command, run: "pi" }));
  const named = new Set(fromPi.map((command) => command.name.toLowerCase()));
  return [...builtins.filter((command) => !named.has(command.name.toLowerCase())), ...fromPi];
}

/**
 * A slash query is a `/` at the very start of an otherwise unbroken word. Once a space follows,
 * the user is writing an argument and the palette has said its piece.
 *
 * @param {string} text
 * @returns {SlashQuery | null}
 */
export function parseCommands(text) {
  if (!text.startsWith("/")) return null;
  if (text.includes("\n")) return null;

  const body = text.slice(1);
  if (body.includes(" ")) return null;
  if (body.includes("\t")) return null;

  return { query: body };
}

/**
 * A sent line as a command, argument and all, or nothing when it is prose that only starts like one.
 *
 * @param {string} text
 * @returns {{name: string, argument: string} | null}
 */
export function parseSlash(text) {
  const line = text.trim();
  if (!line.startsWith("/") || line.includes("\n")) return null;

  const body = line.slice(1);
  const cut = body.search(/\s/);
  const name = cut < 0 ? body : body.slice(0, cut);
  if (name.length === 0) return null;

  return { name: name.toLowerCase(), argument: cut < 0 ? "" : body.slice(cut + 1).trim() };
}

/**
 * How a command line runs, or null when neither pi nor this page knows it, which leaves it a prompt.
 *
 * @param {{name: string, argument: string}} call
 * @param {Command[]} reported
 * @returns {{name: string, run: string, argument: string} | null}
 */
export function slashRun(call, reported) {
  if (reported.some((command) => command.name.toLowerCase() === call.name)) return { ...call, run: "pi" };
  const own = builtins.find((command) => command.name === call.name);
  return own ? { name: own.name, run: own.run, argument: call.argument } : null;
}

/**
 * Prefix matches first, then word-boundary matches, then anything containing the query at all.
 * Ties keep pi's own order, which already puts the built-ins before extensions.
 *
 * @template {{name: string, description?: string, argumentHint?: string}} T
 * @param {T[]} commands
 * @param {string} query
 * @returns {T[]}
 */
export function filterCommands(commands, query) {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return commands.slice(0, limit);

  const scored = /** @type {{command: T, score: number, index: number}[]} */ ([]);

  commands.forEach((command, index) => {
    const name = command.name.toLowerCase();
    const description = (command.description ?? "").toLowerCase();

    let score = -1;
    if (name.startsWith(needle)) score = 0;
    else if (name.split(/[-_:]/).some((part) => part.startsWith(needle))) score = 1;
    else if (name.includes(needle)) score = 2;
    else if (description.includes(needle)) score = 3;

    if (score >= 0) scored.push({ command, score, index });
  });

  scored.sort((a, b) => (a.score === b.score ? a.index - b.index : a.score - b.score));
  return scored.slice(0, limit).map((entry) => entry.command);
}
