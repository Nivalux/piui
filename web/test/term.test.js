// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import { Terminal } from "../term.js";

/** @param {number} [rows] @param {number} [cols] */
function open(rows = 5, cols = 20) {
  return new Terminal(rows, cols);
}

/** The screen as plain text, one entry per row, trailing blanks dropped. */
function lines(/** @type {Terminal} */ term) {
  return term.render().screen.map((runs) =>
    runs
      .map((run) => run.text)
      .join("")
      .replace(/\s+$/, ""),
  );
}

function row(/** @type {Terminal} */ term, /** @type {number} */ index) {
  return lines(term)[index];
}

test("what is written shows up where the cursor stands", () => {
  const term = open();
  term.write("hello");
  assert.equal(row(term, 0), "hello");
  assert.deepEqual(term.render().cursor, { row: 0, col: 5, visible: true });
});

test("a line longer than the window folds onto the next", () => {
  const term = open(5, 10);
  term.write("0123456789ab");
  assert.equal(row(term, 0), "0123456789");
  assert.equal(row(term, 1), "ab");
});

test("carriage return, line feed and backspace move as a tty moves", () => {
  const term = open();
  term.write("first\rsecond\r\nthird\b!");
  assert.equal(row(term, 0), "second");
  assert.equal(row(term, 1), "thir!");
});

test("a tab jumps to the next eighth column", () => {
  const term = open();
  term.write("a\tb");
  assert.equal(row(term, 0), "a       b");
});

test("colours come back as classes, and reset takes them off", () => {
  const term = open();
  term.write("\x1b[31mred\x1b[0m plain");
  const [first, second] = term.render().screen[0];
  assert.equal(first.text, "red");
  assert.equal(first.cls, "t-fg1");
  assert.equal(second.cls, "");
});

test("bold and underline ride along with a colour", () => {
  const term = open();
  term.write("\x1b[1;4;32mb");
  assert.equal(term.render().screen[0][0].cls, "t-b t-u t-fg2");
});

test("the bright half of the palette and 256 colours both land on the pen", () => {
  const term = open();
  term.write("\x1b[91mA");
  assert.equal(term.render().screen[0][0].cls, "t-fg9");

  const wide = open();
  wide.write("\x1b[38;5;10mB");
  assert.equal(wide.render().screen[0][0].style, "color:#00ff00");

  const truecolor = open();
  truecolor.write("\x1b[38;2;10;20;30mC");
  assert.equal(truecolor.render().screen[0][0].style, "color:rgb(10,20,30)");
});

test("erase from the cursor leaves what was written before it", () => {
  const term = open();
  term.write("abcdef");
  term.write("\x1b[1;3H\x1b[K");
  assert.equal(row(term, 0), "ab");
});

test("erase the whole screen leaves an empty one", () => {
  const term = open();
  term.write("one\ntwo\nthree");
  term.write("\x1b[2J");
  assert.deepEqual(lines(term), ["", "", "", "", ""]);
});

test("a cursor placed by number lands on that number", () => {
  const term = open();
  term.write("\x1b[3;7HX");
  assert.equal(row(term, 2), "      X");
});

test("what scrolls past the top is kept to read back", () => {
  const term = open(3, 20);
  term.write("one\r\ntwo\r\nthree\r\nfour\r\nfive");
  assert.deepEqual(lines(term), ["three", "four", "five"]);
  assert.equal(term.render().history.length, 2);
});

test("inserting a line pushes what was there down", () => {
  const term = open(3, 20);
  term.write("one\r\ntwo\r\nthree");
  term.write("\x1b[2;1H\x1b[1L");
  assert.equal(row(term, 0), "one");
  assert.equal(row(term, 1), "");
  assert.equal(row(term, 2), "two");
});

test("deleting a line pulls the rest up", () => {
  const term = open(3, 20);
  term.write("one\r\ntwo\r\nthree");
  term.write("\x1b[2;1H\x1b[1M");
  assert.equal(row(term, 0), "one");
  assert.equal(row(term, 1), "three");
});

test("characters inserted and deleted move along one line", () => {
  const term = open(3, 20);
  term.write("abcdef");
  term.write("\x1b[1;3H\x1b[2@");
  assert.equal(row(term, 0), "ab  cdef");

  term.write("\x1b[1;3H\x1b[2P");
  assert.equal(row(term, 0), "abcdef");
});

test("the alternate screen is another screen, and leaving it gives the old one back", () => {
  const term = open(3, 20);
  term.write("ordinary");
  term.write("\x1b[?1049h");
  assert.equal(row(term, 0), "");
  term.write("fullscreen");
  assert.equal(row(term, 0), "fullscreen");

  term.write("\x1b[?1049l");
  assert.equal(row(term, 0), "ordinary");
});

test("a window that changes size keeps what was written", () => {
  const term = open(3, 10);
  term.write("alpha\r\nbravo\r\ncharlie");
  term.resize(3, 20);
  assert.deepEqual(lines(term), ["alpha", "bravo", "charlie"]);

  const wider = open(3, 30);
  wider.write("alpha\r\nbravo\r\ncharlie");
  wider.resize(3, 20);
  assert.deepEqual(lines(wider), ["alpha", "bravo", "charlie"]);
});

test("a narrower window folds the lines again instead of cutting them", () => {
  const term = open(2, 20);
  term.write("abcdefghij");
  term.resize(3, 4);
  assert.deepEqual(lines(term), ["abcd", "efgh", "ij"]);
});

test("a sequence nobody implements leaves no letters behind", () => {
  const term = open();
  term.write("\x1b[?2004h\x1b[>4;2m\x1b[?1hbefore\x1b(Bafter");
  assert.equal(row(term, 0), "beforeafter");
});

test("the window title is read out and nothing else", () => {
  const term = open();
  /** @type {string[]} */
  const seen = [];
  term.onTitle = (title) => {
    seen.push(title);
  };
  term.write("\x1b]0;~/project\x07hi");
  assert.deepEqual(seen, ["~/project"]);
  assert.equal(row(term, 0), "hi");
});

test("a program asking where the cursor is gets an answer", () => {
  const term = open();
  /** @type {string[]} */
  const sent = [];
  term.onReport = (text) => {
    sent.push(text);
  };
  term.write("\x1b[3;4H\x1b[6n");
  assert.deepEqual(sent, ["\x1b[3;4R"]);
});

test("a scroll region scrolls inside itself and leaves the rest alone", () => {
  const term = open(4, 20);
  term.write("a\r\nb\r\nc\r\nd");
  term.write("\x1b[2;3r");
  term.write("\x1b[3;1Hx\r\ny");
  assert.deepEqual(lines(term), ["a", "x", "y", "d"]);
});

test("reset wipes the screen and the pen", () => {
  const term = open();
  term.write("\x1b[31mred");
  term.write("\x1bc");
  assert.equal(row(term, 0), "");
  assert.equal(term.render().history.length, 0);
});

test("a control character that means nothing is not printed", () => {
  const term = open();
  term.write("a\x00b\x07c");
  assert.equal(row(term, 0), "abc");
});
