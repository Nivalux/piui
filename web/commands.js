// @ts-check

/**
 * The `/` palette.
 *
 * The list is pi's own — `get_commands` answers with everything the session
 * offers, extensions and prompt templates included — so this only decides what
 * counts as a slash query and in which order the matches are worth showing.
 */

/** @typedef {import("./protocol.js").Command} Command */

/** @typedef {{query: string}} SlashQuery */

/** How many rows the palette shows before the user has to type more. */
export const limit = 12;

/**
 * A slash query is a `/` at the very start of an otherwise unbroken word. Once
 * a space follows, the user is writing an argument and the palette has said its
 * piece.
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
 * Prefix matches first, then word-boundary matches, then anything containing the
 * query at all. Ties keep pi's own order, which already puts the built-ins
 * before extensions.
 *
 * @param {Command[]} commands
 * @param {string} query
 * @returns {Command[]}
 */
export function filterCommands(commands, query) {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return commands.slice(0, limit);

  const scored = /** @type {{command: Command, score: number, index: number}[]} */ ([]);

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
