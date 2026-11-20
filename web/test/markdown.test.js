// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdown } from "../markdown.js";

/** @param {string} markdown @returns {any[]} */
const blocks = (markdown) => parseMarkdown(markdown);
/** @param {string} text @returns {any[]} */
const inline = (text) => parseInline(text);

test("paragraphs, and a single newline kept inside one", () => {
  const doc = blocks("one\ntwo\n\nthree");
  assert.equal(doc.length, 2);
  assert.equal(doc[0].kind, "paragraph");
  assert.equal(doc[0].inline[0].text, "one\ntwo");
  assert.equal(doc[1].inline[0].text, "three");
});

test("two trailing spaces still put the next line on its own line", () => {
  assert.equal(blocks("one  \ntwo")[0].inline[0].text, "one\ntwo");
});

test("heading levels, and a hash that is not one", () => {
  assert.deepEqual(
    blocks("# a\n## b\n### c").map((node) => [node.kind, node.level]),
    [
      ["heading", 1],
      ["heading", 2],
      ["heading", 3],
    ],
  );
  assert.equal(blocks("#not-a-heading")[0].kind, "paragraph");
});

test("bold, italic, strike and code", () => {
  assert.deepEqual(
    inline("a **b** *c* ~~d~~ `e`").map((node) => node.kind),
    ["text", "strong", "text", "em", "text", "del", "text", "code"],
  );
  assert.equal(inline("**b**")[0].inline[0].text, "b");
  assert.equal(inline("__b__")[0].kind, "strong");
  assert.equal(inline("~~d~~")[0].inline[0].text, "d");
  assert.equal(inline("`e`")[0].text, "e");
});

test("nothing is invented where a marker does not close", () => {
  assert.equal(inline("a **b")[0].text, "a **b");
  assert.equal(inline("2 * 4 * 6")[0].text, "2 * 4 * 6");
});

test("an underscore inside a word is part of the word", () => {
  assert.equal(inline("snake_case_name")[0].text, "snake_case_name");
  assert.equal(inline("a _real_ one")[1].kind, "em");
});

test("a code span keeps its own markers", () => {
  assert.equal(inline("`a **b** c`")[0].text, "a **b** c");
  assert.equal(inline("` spaced `")[0].text, "spaced");
});

test("links, bare urls and angled urls", () => {
  const link = inline("see [pi](https://example.com)").find((node) => node.kind === "link");
  assert.equal(link.href, "https://example.com");
  assert.equal(link.inline[0].text, "pi");

  assert.equal(inline("at https://other.test now")[1].href, "https://other.test");
  assert.equal(inline("<https://angled.test>")[0].href, "https://angled.test");
});

test("a url does not swallow the punctuation after it", () => {
  const nodes = inline("read https://example.com/page, then go");
  assert.equal(nodes[1].href, "https://example.com/page");
  assert.equal(nodes[2].text, ", then go");
});

test("an image reads as its alt text", () => {
  const nodes = inline("![logo](https://example.com/a.png)");
  assert.equal(nodes[0].kind, "link");
  assert.equal(nodes[0].inline[0].text, "logo");
});

test("bullets, and bullets inside bullets", () => {
  const list = blocks("- a\n  - b\n- c")[0];
  assert.equal(list.kind, "list");
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].inline[0].text, "a");
  assert.equal(list.items[0].blocks[0].items[0].inline[0].text, "b");
});

test("a numbered list keeps its kind", () => {
  const list = blocks("1. one\n2. two")[0];
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2);
});

test("a list interrupts a paragraph, a heading ends it", () => {
  assert.deepEqual(
    blocks("prose\n- item\n\n# next\nmore").map((node) => node.kind),
    ["paragraph", "list", "heading", "paragraph"],
  );
});

test("task items keep their tick", () => {
  const items = blocks("- [x] done\n- [ ] open")[0].items;
  assert.equal(items[0].checked, true);
  assert.equal(items[0].inline[0].text, "done");
  assert.equal(items[1].checked, false);
});

test("a code block inside a bullet", () => {
  const item = blocks("- run:\n\n  ```sh\n  make\n  ```")[0].items[0];
  assert.equal(item.blocks[0].kind, "code");
  assert.equal(item.blocks[0].lang, "sh");
  assert.equal(item.blocks[0].text, "make");
});

test("a fenced block keeps its text verbatim", () => {
  const code = blocks("```ts\nconst a = 1;\n**not bold**\n```")[0];
  assert.equal(code.kind, "code");
  assert.equal(code.lang, "ts");
  assert.equal(code.text, "const a = 1;\n**not bold**");
});

test("an unclosed fence runs to the end", () => {
  assert.equal(blocks("```\nopen\nstill open")[0].text, "open\nstill open");
});

test("a quote, with a lazy continuation", () => {
  const quote = blocks("> one\n> two\nthree")[0];
  assert.equal(quote.kind, "quote");
  assert.equal(quote.blocks[0].inline[0].text, "one\ntwo\nthree");
});

test("rules", () => {
  assert.deepEqual(
    blocks("---\n\n***\n\n___").map((node) => node.kind),
    ["rule", "rule", "rule"],
  );
});

test("a table with alignment and short rows", () => {
  const table = blocks("| a | b | c |\n|:---|:--:|--:|\n| 1 | 2 |")[0];
  assert.equal(table.kind, "table");
  assert.equal(table.head.length, 3);
  assert.deepEqual(table.align, ["", "center", "right"]);
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].length, 3);
  assert.equal(table.rows[0][2][0].text, "");
});

test("markup in a table cell is still read", () => {
  const cell = blocks("| a |\n|---|\n| **b** |")[0].rows[0][0];
  assert.equal(cell[0].kind, "strong");
});

test("raw html stays characters", () => {
  assert.equal(blocks("<script>alert(1)</script>")[0].inline[0].text, "<script>alert(1)</script>");
});

test("an empty answer is nothing at all", () => {
  assert.deepEqual(blocks(""), []);
  assert.deepEqual(blocks("   \n\n  "), []);
});
