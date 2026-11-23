// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import { Terminal } from "../term.js";
import { signature } from "../termview.js";

test("a colour that changed on its own is a frame worth painting", () => {
  const term = new Terminal(4, 20);
  term.write("\x1b[31mx");
  const red = signature(term.render());
  term.write("\r\x1b[32mx");
  assert.notEqual(signature(term.render()), red);
});

test("a truecolour that changed on its own is a frame worth painting", () => {
  const term = new Terminal(4, 20);
  term.write("\x1b[38;2;255;0;0mx");
  const red = signature(term.render());
  term.write("\r\x1b[38;2;0;0;255mx");
  assert.notEqual(signature(term.render()), red);
});

test("a frame that changed nothing is the same frame", () => {
  const term = new Terminal(4, 20);
  term.write("same \x1b[31mtext");
  assert.equal(signature(term.render()), signature(term.render()));
});

test("the same letters in another row are another frame", () => {
  const twoRows = new Terminal(4, 20);
  twoRows.write("a\r\nb");
  const oneRow = new Terminal(4, 20);
  oneRow.write("ab\r\n");
  assert.notEqual(signature(twoRows.render()), signature(oneRow.render()));
});

test("a caret that only moved is a frame worth painting", () => {
  const term = new Terminal(4, 20);
  term.write("x");
  const here = signature(term.render());
  term.write("\x1b[3;4H");
  assert.notEqual(signature(term.render()), here);
});

test("a caret that went away is a frame worth painting", () => {
  const term = new Terminal(4, 20);
  const shown = signature(term.render());
  term.write("\x1b[?25l");
  assert.notEqual(signature(term.render()), shown);
});
