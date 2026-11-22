// @ts-check

/**
 * Markdown, read the way the chat needs it.
 *
 * @typedef {{kind:"text", text: string}} Text
 * @typedef {{kind:"code", text: string}} Code
 * @typedef {{kind:"strong", inline: Inline[]}} Strong
 * @typedef {{kind:"em", inline: Inline[]}} Em
 * @typedef {{kind:"del", inline: Inline[]}} Del
 * @typedef {{kind:"link", href: string, inline: Inline[]}} Link
 * @typedef {Text | Code | Strong | Em | Del | Link} Inline
 *
 * @typedef {{kind:"paragraph", inline: Inline[]}} Paragraph
 * @typedef {{kind:"heading", level: number, inline: Inline[]}} Heading
 * @typedef {{kind:"code", lang: string, text: string}} CodeBlock
 * @typedef {{kind:"rule"}} Rule
 * @typedef {{kind:"quote", blocks: Block[]}} Quote
 * @typedef {{kind:"list", ordered: boolean, items: Item[]}} List
 * @typedef {{inline: Inline[], blocks: Block[], checked: boolean | null}} Item
 * @typedef {{kind:"table", head: Inline[][], align: string[], rows: Inline[][][]}} Table
 * @typedef {Paragraph | Heading | CodeBlock | Rule | Quote | List | Table} Block
 */

const fence = /^(\s*)(`{3,}|~{3,})[ \t]*([\w+-]*)[ \t]*$/;
const heading = /^(\s{0,3})(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const rule = /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const bullet = /^(\s*)([-*+])[ \t]+(.*)$/;
const numbered = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/;
const quote = /^(\s{0,3})>[ ]?(.*)$/;
const tableRow = /^\s{0,3}\|.*\|\s*$/;
const tableSplit = /^\s{0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?\s*$/;

/**
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  return blocks(lines);
}

/**
 * @param {string[]} lines
 * @returns {Block[]}
 */
function blocks(lines) {
  /** @type {Block[]} */
  const out = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const open = fence.exec(line);
    if (open) {
      const marker = open[2][0];
      const width = open[2].length;
      const body = [];
      index += 1;
      while (index < lines.length) {
        const close = fence.exec(lines[index]);
        if (close && close[2][0] === marker && close[2].length >= width && lines[index].trim().length === width) break;
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      out.push({ kind: "code", lang: open[3] ?? "", text: body.join("\n") });
      continue;
    }

    if (rule.test(line)) {
      out.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const title = heading.exec(line);
    if (title) {
      out.push({ kind: "heading", level: title[2].length, inline: parseInline(title[3]) });
      index += 1;
      continue;
    }

    if (quote.test(line)) {
      const quoted = [];
      while (index < lines.length && (quote.test(lines[index]) || continues(quoted, lines[index]))) {
        const match = quote.exec(lines[index]);
        quoted.push(match ? match[2] : lines[index]);
        index += 1;
      }
      out.push({ kind: "quote", blocks: blocks(quoted) });
      continue;
    }

    if (tableRow.test(line) && index + 1 < lines.length && tableSplit.test(lines[index + 1])) {
      const head = cells(line);
      const align = cells(lines[index + 1]).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "",
      );
      index += 2;
      /** @type {Inline[][][]} */
      const rows = [];
      while (index < lines.length && tableRow.test(lines[index])) {
        rows.push(cells(lines[index]).map((cell) => parseInline(cell)));
        index += 1;
      }
      out.push({
        kind: "table",
        head: head.map((cell) => parseInline(cell)),
        align,
        rows: rows.map((row) => pad(row, head.length)),
      });
      continue;
    }

    if (bullet.test(line) || numbered.test(line)) {
      const list = collect(lines, index);
      out.push(list.block);
      index = list.next;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && isProse(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    out.push({ kind: "paragraph", inline: parseInline(paragraph.join("\n")) });
  }

  return out;
}

/**
 * A paragraph runs until a blank line or the start of anything with a shape of its own.
 *
 * @param {string} line
 */
function isProse(line) {
  if (line.trim().length === 0) return false;
  return !(
    fence.test(line) ||
    rule.test(line) ||
    heading.test(line) ||
    quote.test(line) ||
    bullet.test(line) ||
    numbered.test(line)
  );
}

/**
 * @param {string[]} kept
 * @param {string} line
 */
function continues(kept, line) {
  return kept.length > 0 && line.trim().length > 0 && !quote.test(line);
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @returns {{block: List, next: number}}
 */
function collect(lines, start) {
  const first = bullet.exec(lines[start]) ?? numbered.exec(lines[start]);
  const ordered = numbered.test(lines[start]);
  const indent = first ? first[1].length : 0;

  /** @type {Item[]} */
  const items = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    const open = bullet.exec(line) ?? numbered.test(line) ? numbered.exec(line) ?? bullet.exec(line) : null;

    if (open && open[1].length >= indent) {
      if (open[1].length > indent) break;
      const body = [open[3]];
      index += 1;
      while (index < lines.length) {
        const next = lines[index];
        if (next.trim().length === 0) {
          body.push("");
          index += 1;
          continue;
        }
        const leading = next.length - next.trimStart().length;
        if (leading <= indent) break;
        body.push(next.slice(Math.min(leading, indent + 2)));
        index += 1;
      }
      items.push(itemOf(body.join("\n")));
      continue;
    }

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    break;
  }

  return { block: { kind: "list", ordered, items }, next: index };
}

/**
 * The first lines of a list item are its own text, anything deeper belongs to it as nested blocks.
 *
 * @param {string} text
 * @returns {Item}
 */
function itemOf(text) {
  const trimmed = text.replace(/^\n+|\s+$/g, "");
  const task = /^\[([ xX])\][ \t]+/.exec(trimmed);
  const body = task ? trimmed.slice(task[0].length) : trimmed;
  const lines = body.split("\n");
  const head = lines.shift() ?? "";
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  return {
    inline: parseInline(head),
    blocks: blocks(lines),
    checked: task ? task[1].toLowerCase() === "x" : null,
  };
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function cells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * @param {Inline[][]} row
 * @param {number} width
 * @returns {Inline[][]}
 */
function pad(row, width) {
  const filled = row.slice(0, width);
  while (filled.length < width) filled.push([{ kind: "text", text: "" }]);
  return filled;
}

/**
 * One pass, left to right, named groups only. Numbered groups here were a trap once: an
 * alternative added in the middle shifted every later index and the answer came out with pieces
 * missing.
 */
const inlineSource = [
  "(?<fence>`+)(?<codeBody>[\\s\\S]*?)\\k<fence>",
  "!?\\[(?<linkText>[^\\]]*)\\]\\((?<linkHref>[^)\\s]+)(?:[ \\t]+\"[^\"]*\")?\\)",
  "(?<bold>\\*\\*|__)(?=\\S)(?<boldBody>[\\s\\S]*?\\S)\\k<bold>",
  "(?<slant>\\*|_)(?=\\S)(?<slantBody>[\\s\\S]*?\\S)\\k<slant>",
  "~~(?=\\S)(?<strikeBody>[\\s\\S]*?\\S)~~",
  "<(?<angled>https?:\\/\\/[^>\\s]+)>",
  "(?<bare>https?:\\/\\/[^\\s<>)\\]]+)",
  "(?<break>(?: {2,}|\\\\)\\n)",
].join("|");

/**
 * @param {string} text
 * @returns {Inline[]}
 */
export function parseInline(text) {
  const source = String(text ?? "");
  const pattern = new RegExp(inlineSource, "g");
  /** @type {Inline[]} */
  const out = [];
  let cursor = 0;

  /** @param {string} characters */
  const words = (characters) => {
    if (characters.length > 0) out.push({ kind: "text", text: characters });
  };

  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const at = match.index;
    const found = /** @type {Record<string, string | undefined>} */ (match.groups ?? {});
    words(source.slice(cursor, at));
    cursor = at + match[0].length;

    if (found.codeBody !== undefined) {
      out.push({ kind: "code", text: found.codeBody.replace(/^ (?=[\s\S]* $)|^ | $/g, "") });
    } else if (found.linkHref !== undefined) {
      out.push({ kind: "link", href: found.linkHref, inline: parseInline(found.linkText ?? "") });
    } else if (found.boldBody !== undefined) {
      out.push({ kind: "strong", inline: parseInline(found.boldBody) });
    } else if (found.slantBody !== undefined) {
      out.push(
        underscoresInsideWord(found.slant, source, at)
          ? { kind: "text", text: match[0] }
          : { kind: "em", inline: parseInline(found.slantBody) },
      );
    } else if (found.strikeBody !== undefined) {
      out.push({ kind: "del", inline: parseInline(found.strikeBody) });
    } else if (found.angled !== undefined) {
      out.push({ kind: "link", href: found.angled, inline: [{ kind: "text", text: found.angled }] });
    } else if (found.bare !== undefined) {
      const tail = /[.,;:!?)\]]+$/.exec(found.bare)?.[0] ?? "";
      const href = found.bare.slice(0, found.bare.length - tail.length);
      out.push({ kind: "link", href, inline: [{ kind: "text", text: href }] });
      words(tail);
    } else if (found.break !== undefined) {
      out.push({ kind: "text", text: "\n" });
    }
  }

  words(source.slice(cursor));

  /** @type {Inline[]} */
  const merged = [];
  for (const node of out) {
    const last = merged[merged.length - 1];
    if (last?.kind === "text" && node.kind === "text") last.text += node.text;
    else merged.push(node);
  }
  return merged;
}

/**
 * `_` inside a word is part of the word. `*` is always emphasis.
 *
 * @param {string | undefined} marker
 * @param {string} source
 * @param {number} at
 */
function underscoresInsideWord(marker, source, at) {
  if (marker !== "_") return false;
  const before = at > 0 ? source[at - 1] : "";
  return /[\w]/.test(before);
}

/**
 * The DOM half. Kept in the same file as the parser but doing nothing but turning nodes into
 * elements.
 *
 * @param {Block[]} list
 * @returns {DocumentFragment}
 */
export function markdownNode(list) {
  const frag = document.createDocumentFragment();
  for (const block of list) frag.append(blockNode(block));
  return frag;
}

/**
 * @param {Block} block
 * @returns {HTMLElement}
 */
function blockNode(block) {
  switch (block.kind) {
    case "heading": {
      const node = document.createElement(`h${Math.min(block.level, 6)}`);
      node.append(...block.inline.map(inlineNode));
      return node;
    }
    case "code": {
      const pre = document.createElement("pre");
      pre.className = "md-code";
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      if (block.lang.length > 0) pre.dataset.lang = block.lang;
      return pre;
    }
    case "rule":
      return document.createElement("hr");
    case "quote": {
      const node = document.createElement("blockquote");
      node.append(markdownNode(block.blocks));
      return node;
    }
    case "list": {
      const node = document.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = document.createElement("li");
        if (item.checked !== null) {
          li.classList.add("task");
          li.dataset.done = item.checked ? "1" : "0";
        }
        li.append(...item.inline.map(inlineNode));
        if (item.blocks.length > 0) li.append(markdownNode(item.blocks));
        node.append(li);
      }
      return node;
    }
    case "table": {
      const table = document.createElement("table");
      const head = document.createElement("tr");
      block.head.forEach((cell, at) => {
        const th = document.createElement("th");
        alignTo(th, block.align[at]);
        th.append(...cell.map(inlineNode));
        head.append(th);
      });
      table.append(head);
      for (const row of block.rows) {
        const tr = document.createElement("tr");
        row.forEach((cell, at) => {
          const td = document.createElement("td");
          alignTo(td, block.align[at]);
          td.append(...cell.map(inlineNode));
          tr.append(td);
        });
        table.append(tr);
      }
      return table;
    }
    default: {
      const node = document.createElement("p");
      node.append(.../** @type {Inline[]} */ (block.inline).map(inlineNode));
      return node;
    }
  }
}

/** @param {HTMLElement} node @param {string} align */
function alignTo(node, align) {
  if (align !== undefined && align !== "") node.style.textAlign = align;
}

/**
 * @param {Inline} inline
 * @returns {HTMLElement}
 */
function inlineNode(inline) {
  switch (inline.kind) {
    case "code": {
      const node = document.createElement("code");
      node.textContent = inline.text;
      return node;
    }
    case "strong":
    case "em":
    case "del": {
      const node = document.createElement(inline.kind === "strong" ? "strong" : inline.kind === "em" ? "em" : "del");
      node.append(...inline.inline.map(inlineNode));
      return node;
    }
    case "link": {
      const node = document.createElement("a");
      node.href = safeHref(inline.href);
      node.rel = "noreferrer";
      node.target = "_blank";
      node.append(...inline.inline.map(inlineNode));
      return node;
    }
    default: {
      const node = document.createElement("span");
      node.textContent = inline.text;
      return node;
    }
  }
}

/**
 * @param {string} href
 */
function safeHref(href) {
  return /^\s*javascript:/i.test(href) ? "#" : href;
}
