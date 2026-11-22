// @ts-check

/**
 * A terminal window drawn from what a shell writes.
 *
 * Small on purpose: the parts of a VT that a shell, a build and a git command
 * actually use — printing, lines, cursor moves, erasing, colours, a scroll
 * region, an alternate screen. Anything rarer is swallowed rather than drawn
 * wrong, because a swallowed sequence leaves the screen readable and a
 * half-implemented one does not.
 *
 * Nothing here touches the DOM. `write` takes text, `render` hands back rows of
 * runs with a class and a style each, and the page turns those into spans.
 */

const bel = "\x07";
const esc = "\x1b";

/** @type {string[]} */
const palette = buildPalette();

export class Terminal {
  /** @param {number} rows @param {number} cols */
  constructor(rows = 24, cols = 80) {
    this.rows = Math.max(1, rows);
    this.cols = Math.max(1, cols);
    this.main = makeScreen(this.rows, this.cols);
    this.alternate = null;
    /** @type {Cell[][]} */
    this.history = [];
    this.historyLimit = 1000;
    this.row = 0;
    this.col = 0;
    /** Set after a character lands in the last column: the next one wraps. */
    this.wrapPending = false;
    this.cursorVisible = true;
    this.top = 0;
    this.bottom = this.rows - 1;
    /** @type {{bold:boolean,italic:boolean,underline:boolean,inverse:boolean,fg:string,bg:string}} */
    this.pen = blankPen();
    this.saved = { row: 0, col: 0, pen: blankPen() };
    this.title = "";
    /** @type {(text: string) => void} */
    this.onReport = () => {};
    /** @type {(text: string) => void} */
    this.onTitle = () => {};
    this.state = "ground";
    this.params = "";
    this.fallback = "";
  }

  /** @param {number} rows @param {number} cols */
  resize(rows, cols) {
    const height = Math.max(1, rows);
    const width = Math.max(1, cols);
    if (height === this.rows && width === this.cols) return;

    // Rewound from the text rather than moved cell for cell: a line folded in
    // two is two lines of content, and dragging cells across a narrower window
    // would put words where the shell never wrote them. Colour along a line is
    // lost this way, which is what a real terminal does to a line it has to
    // break again.
    const lines = [...this.history, ...this.screen()].map(lineToText);
    // Blank rows at the bottom are the empty part of the window, not content to
    // carry over: kept, they would push the text off the top of a shorter one.
    while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();

    this.rows = height;
    this.cols = width;
    this.top = 0;
    this.bottom = height - 1;

    /** @type {Cell[][]} */
    const rebuilt = [];
    for (const line of lines) rebuilt.push(...wrap(line, width));

    const tail = rebuilt.slice(-height);
    for (let pad = height - tail.length; pad > 0; pad -= 1) tail.unshift(blankLine(width));
    this.history = rebuilt.slice(0, Math.max(0, rebuilt.length - height));

    if (this.alternate) this.alternate = tail;
    else this.main = tail;

    this.row = clamp(this.row, 0, height - 1);
    this.col = clamp(this.col, 0, width - 1);
    this.wrapPending = false;
  }

  /** @param {string} text */
  write(text) {
    for (let i = 0; i < text.length; i += 1) this.#step(text[i]);
  }

  /** The screen as the page wants it: what scrolled past, then what shows. */
  render() {
    return {
      history: this.history.map(runsOf),
      screen: this.screen().map(runsOf),
      cursor: { row: this.row, col: this.col, visible: this.cursorVisible },
      title: this.title,
    };
  }

  /** @returns {Cell[][]} */
  screen() {
    return this.alternate ? this.alternate : this.main;
  }

  /** @param {string} ch */
  #step(ch) {
    if (this.state === "ground") return this.#ground(ch);
    if (this.state === "escape") return this.#escape(ch);
    if (this.state === "params") return this.#params(ch);
    if (this.state === "osc") return this.#osc(ch);
    if (this.state === "charset") {
      this.state = "ground";
      return;
    }
    this.state = "ground";
  }

  /** @param {string} ch */
  #ground(ch) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === esc) {
      this.state = "escape";
      this.params = "";
      return;
    }
    if (ch === "\n" || ch === "\v" || ch === "\f") return this.lineFeed();
    if (ch === "\r") return this.carriageReturn();
    if (ch === "\b") return this.backspace();
    if (ch === "\t") return this.tab();
    if (ch === bel) return;
    if (code < 0x20) return;
    this.#print(ch);
  }

  /** @param {string} ch */
  #escape(ch) {
    if (ch === "[") {
      this.state = "params";
      this.params = "";
      this.fallback = "";
      return;
    }
    if (ch === "]") {
      this.state = "osc";
      this.fallback = "";
      return;
    }
    if (ch === "(" || ch === ")" || ch === "#") {
      this.state = "charset";
      return;
    }
    this.state = "ground";
    if (ch === "M") return this.reverseIndex();
    if (ch === "7") return this.#save();
    if (ch === "8") return this.#restore();
    if (ch === "c") return this.reset();
  }

  /** @param {string} ch */
  #params(ch) {
    if ((ch >= "0" && ch <= "9") || ch === ";" || ch === "?" || ch === ">" || ch === "<" || ch === "=") {
      this.params += ch;
      if (this.params.length > 32) this.state = "ground";
      return;
    }
    const privateMode = this.params.startsWith("?");
    const digits = privateMode ? this.params.slice(1) : this.params;
    const args = parseArgs(digits);
    this.state = "ground";
    this.#dispatch(ch, args, privateMode);
  }

  /** @param {string} ch */
  #osc(ch) {
    if (ch === bel) return this.#endOsc("ground");
    if (ch === esc) {
      // The string terminator is ESC \; whatever follows the backslash ends it.
      return this.#endOsc("st");
    }
    if (this.fallback.length < 512) this.fallback += ch;
  }

  /** @param {string} state */
  #endOsc(state) {
    // "0;title" and "2;title" both set the title; the number says which of the
    // two slots and is not part of the text.
    this.title = this.fallback.replace(/^\d+;/, "");
    this.onTitle(this.title);
    this.state = state;
  }

  /**
   * @param {string} final
   * @param {number[]} args
   * @param {boolean} priv
   */
  #dispatch(final, args, priv) {
    const first = args.length > 0 ? args[0] : 0;

    if (final === "A") return this.moveCursor(-(first || 1), 0);
    if (final === "B") return this.moveCursor(first || 1, 0);
    if (final === "C") return this.moveCursor(0, first || 1);
    if (final === "D") return this.moveCursor(0, -(first || 1));
    if (final === "E") return this.moveCursor(first || 1, 0, true);
    if (final === "F") return this.moveCursor(-(first || 1), 0, true);
    if (final === "d") return this.setRow(first - 1);
    if (final === "G" || final === "`") return this.setCol(first - 1);
    if (final === "H" || final === "f") return this.place(first - 1, (args[1] ?? 1) - 1);

    if (final === "J") return this.eraseDisplay(first);
    if (final === "K") return this.eraseLine(first);
    if (final === "X") return this.eraseChars(first || 1);
    if (final === "@") return this.insertChars(first || 1);
    if (final === "P") return this.deleteChars(first || 1);
    if (final === "L") return this.insertLines(first || 1);
    if (final === "M") return this.deleteLines(first || 1);
    if (final === "S") return this.scrollUp(first || 1);
    if (final === "T") return this.scrollDown(first || 1);
    if (final === "r") return this.setRegion(first - 1, (args[1] ?? this.rows) - 1);

    if (final === "m") return this.applyPen(args);

    if (final === "h" || final === "l") {
      const on = final === "h";
      if (priv && first === 25) return void (this.cursorVisible = on);
      if (priv && (first === 1049 || first === 1047 || first === 47)) return this.useAlternate(on, first === 1049);
      // Bracketed paste, application cursor keys, auto-wrap: the page sends what
      // it sends either way, and nothing here changes shape over it.
      return;
    }

    if (final === "s") return this.#save();
    if (final === "u") return this.#restore();
    if (final === "n") {
      if (first === 5) return this.onReport(`${esc}[0n`);
      if (first === 6) return this.onReport(`${esc}[${this.row + 1};${this.col + 1}R`);
      return;
    }
  }

  /** @param {string} ch */
  #print(ch) {
    this.row = clamp(this.row, 0, this.rows - 1);
    this.col = clamp(this.col, 0, this.cols - 1);
    if (this.wrapPending) {
      this.wrapPending = false;
      this.carriageReturn();
      this.lineFeed();
    }

    const line = this.screen()[this.row];
    line[this.col] = { ch, pen: { ...this.pen } };
    if (this.col + 1 >= this.cols) {
      this.wrapPending = true;
      return;
    }
    this.col += 1;
  }

  carriageReturn() {
    this.col = 0;
    this.wrapPending = false;
  }

  backspace() {
    if (this.col === 0) return;
    this.col -= 1;
    this.wrapPending = false;
  }

  tab() {
    this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
    this.wrapPending = false;
  }

  lineFeed() {
    this.wrapPending = false;
    if (this.row === this.bottom) return this.scrollUp(1);
    this.row = Math.min(this.rows - 1, this.row + 1);
  }

  reverseIndex() {
    if (this.row === this.top) return this.scrollDown(1);
    this.row = Math.max(0, this.row - 1);
  }

  /** @param {number} amount */
  scrollUp(amount) {
    const screen = this.screen();
    for (let i = 0; i < amount; i += 1) {
      const gone = screen.splice(this.top, 1)[0];
      screen.splice(this.bottom, 0, blankLine(this.cols));
      // Only the whole screen is worth remembering: a region scrolling inside a
      // full-screen program is not something to read back later.
      if (!this.alternate && this.top === 0 && this.bottom === this.rows - 1) this.#remember(gone);
    }
    this.row = Math.min(this.row, this.bottom);
  }

  /** @param {number} amount */
  scrollDown(amount) {
    const screen = this.screen();
    for (let i = 0; i < amount; i += 1) {
      screen.splice(this.bottom, 0, blankLine(this.cols));
      screen.splice(this.top, 1);
    }
    this.row = Math.max(this.row, this.top);
  }

  /** @param {Cell[]} line */
  #remember(line) {
    if (this.history.length >= this.historyLimit) this.history.shift();
    this.history.push(line);
  }

  /**
   * @param {number} dRows
   * @param {number} dCols
   * @param {boolean} [home]
   */
  moveCursor(dRows, dCols, home = false) {
    if (home) this.col = 0;
    this.row = clamp(this.row + dRows, 0, this.rows - 1);
    this.col = clamp(this.col + dCols, 0, this.cols - 1);
    this.wrapPending = false;
  }

  /** @param {number} row @param {number} col */
  place(row, col) {
    this.row = clamp(row < 0 ? 0 : row, 0, this.rows - 1);
    this.col = clamp(col < 0 ? 0 : col, 0, this.cols - 1);
    this.wrapPending = false;
  }

  /** @param {number} row */
  setRow(row) {
    this.row = clamp(row, 0, this.rows - 1);
    this.wrapPending = false;
  }

  /** @param {number} col */
  setCol(col) {
    this.col = clamp(col, 0, this.cols - 1);
    this.wrapPending = false;
  }

  /** @param {number} how */
  eraseDisplay(how) {
    const screen = this.screen();
    if (how === 2 || how === 3) {
      for (let row = 0; row < this.rows; row += 1) screen[row] = blankLine(this.cols);
      if (how === 3 && !this.alternate) this.history = [];
      return;
    }
    if (how === 0) {
      clear(this.screen()[this.row], this.col, this.cols);
      for (let row = this.row + 1; row < this.rows; row += 1) screen[row] = blankLine(this.cols);
      return;
    }
    for (let row = 0; row < this.row; row += 1) screen[row] = blankLine(this.cols);
    clear(this.screen()[this.row], 0, this.col + 1);
  }

  /** @param {number} how */
  eraseLine(how) {
    const line = this.screen()[this.row];
    if (how === 1) return clear(line, 0, this.col + 1);
    if (how === 2) return clear(line, 0, this.cols);
    clear(line, this.col, this.cols);
  }

  /** @param {number} count */
  eraseChars(count) {
    const line = this.screen()[this.row];
    clear(line, this.col, Math.min(this.cols, this.col + count));
  }

  /** @param {number} count */
  insertChars(count) {
    const line = this.screen()[this.row];
    const room = Math.min(count, this.cols - this.col);
    for (let i = this.cols - 1; i >= this.col; i -= 1) line[i] = line[i - room] ?? blankCell();
    clear(line, this.col, this.col + room);
  }

  /** @param {number} count */
  deleteChars(count) {
    const line = this.screen()[this.row];
    const room = Math.min(count, this.cols - this.col);
    for (let i = this.col; i < this.cols; i += 1) line[i] = line[i + room] ?? blankCell();
    clear(line, this.cols - room, this.cols);
  }

  /** @param {number} count */
  insertLines(count) {
    const screen = this.screen();
    if (this.row < this.top || this.row > this.bottom) return;
    for (let i = 0; i < count; i += 1) {
      screen.splice(this.row, 0, blankLine(this.cols));
      screen.splice(this.bottom + 1, 1);
    }
  }

  /** @param {number} count */
  deleteLines(count) {
    const screen = this.screen();
    if (this.row < this.top || this.row > this.bottom) return;
    for (let i = 0; i < count; i += 1) {
      screen.splice(this.row, 1);
      screen.splice(this.bottom + 1, 0, blankLine(this.cols));
    }
  }

  /** @param {number} top @param {number} bottom */
  setRegion(top, bottom) {
    if (top < 0 || bottom > this.rows - 1 || bottom <= top) return;
    this.top = top;
    this.bottom = bottom;
    this.place(0, 0);
  }

  /** @param {number[]} args */
  applyPen(args) {
    const list = args.length === 0 ? [0] : args;
    const pen = { ...this.pen };
    for (let i = 0; i < list.length; i += 1) {
      const code = list[i];
      if (code === 0) {
        Object.assign(pen, blankPen());
        continue;
      }
      if (code === 1) pen.bold = true;
      if (code === 3) pen.italic = true;
      if (code === 4) pen.underline = true;
      if (code === 7) pen.inverse = true;
      if (code === 22) pen.bold = false;
      if (code === 23) pen.italic = false;
      if (code === 24) pen.underline = false;
      if (code === 27) pen.inverse = false;
      if (code >= 30 && code <= 37) pen.fg = `t-fg${code - 30}`;
      if (code >= 40 && code <= 47) pen.bg = `t-bg${code - 40}`;
      if (code >= 90 && code <= 97) pen.fg = `t-fg${code - 90 + 8}`;
      if (code >= 100 && code <= 107) pen.bg = `t-bg${code - 100 + 8}`;
      if (code === 39) pen.fg = "";
      if (code === 49) pen.bg = "";
      if ((code === 38 || code === 48) && list[i + 1] === 5) {
        const color = palette[list[i + 2] ?? 0] ?? "";
        if (code === 38) pen.fg = color;
        else pen.bg = color;
        i += 2;
        continue;
      }
      if ((code === 38 || code === 48) && list[i + 1] === 2) {
        const red = list[i + 2] ?? 0;
        const green = list[i + 3] ?? 0;
        const blue = list[i + 4] ?? 0;
        const color = `rgb(${red},${green},${blue})`;
        if (code === 38) pen.fg = color;
        else pen.bg = color;
        i += 4;
      }
    }
    this.pen = pen;
  }

  #save() {
    this.saved = { row: this.row, col: this.col, pen: { ...this.pen } };
  }

  #restore() {
    this.row = this.saved.row;
    this.col = this.saved.col;
    this.pen = { ...this.saved.pen };
  }

  /** @param {boolean} on @param {boolean} clearHistory */
  useAlternate(on, clearHistory) {
    if (on) {
      if (this.alternate) return;
      this.#save();
      this.alternate = makeScreen(this.rows, this.cols);
      if (clearHistory) this.history = [];
      this.place(0, 0);
      return;
    }
    if (!this.alternate) return;
    this.alternate = null;
    this.#restore();
  }

  reset() {
    this.main = makeScreen(this.rows, this.cols);
    this.alternate = null;
    this.history = [];
    this.row = 0;
    this.col = 0;
    this.pen = blankPen();
    this.top = 0;
    this.bottom = this.rows - 1;
    this.cursorVisible = true;
    this.wrapPending = false;
  }
}

/** @typedef {{ch: string, pen: Pen}} Cell */
/** @typedef {{bold: boolean, italic: boolean, underline: boolean, inverse: boolean, fg: string, bg: string}} Pen */

/** @returns {Pen} */
function blankPen() {
  return { bold: false, italic: false, underline: false, inverse: false, fg: "", bg: "" };
}

/** @returns {Cell} */
function blankCell() {
  return { ch: " ", pen: blankPen() };
}

/**
 * @param {number} rows
 * @param {number} cols
 * @returns {Cell[][]}
 */
function makeScreen(rows, cols) {
  /** @type {Cell[][]} */
  const lines = [];
  for (let i = 0; i < rows; i += 1) lines.push(blankLine(cols));
  return lines;
}

/** @param {number} cols @returns {Cell[]} */
function blankLine(cols) {
  const line = [];
  for (let i = 0; i < cols; i += 1) line.push(blankCell());
  return line;
}

/**
 * @param {Cell[]} line
 * @param {number} from
 * @param {number} to
 */
function clear(line, from, to) {
  for (let i = Math.max(0, from); i < Math.min(line.length, to); i += 1) line[i] = blankCell();
}

/** @param {Cell[]} line @returns {string} */
function lineToText(line) {
  let text = "";
  for (const cell of line) text += cell.ch;
  return text.replace(/\s+$/, "");
}

/** @param {string} line @param {number} cols @returns {Cell[][]} */
function wrap(line, cols) {
  if (line.length === 0) return [blankLine(cols)];
  /** @type {Cell[][]} */
  const pieces = [];
  for (let i = 0; i < line.length; i += cols) {
    const piece = blankLine(cols);
    const part = line.slice(i, i + cols);
    for (let j = 0; j < part.length; j += 1) piece[j] = { ch: part[j], pen: blankPen() };
    pieces.push(piece);
  }
  return pieces;
}

/**
 * A row as runs of equal look, so the page writes one span per look rather than
 * one per character.
 *
 * @param {Cell[]} line
 * @returns {{text: string, cls: string, style: string}[]}
 */
function runsOf(line) {
  /** @type {{text: string, cls: string, style: string}[]} */
  const runs = [];
  for (const cell of line) {
    const cls = classOf(cell.pen);
    const style = styleOf(cell.pen);
    const last = runs[runs.length - 1];
    if (last && last.cls === cls && last.style === style) {
      last.text += cell.ch;
      continue;
    }
    runs.push({ text: cell.ch, cls, style });
  }
  return runs;
}

/** @param {Pen} pen @returns {string} */
function classOf(pen) {
  const parts = [];
  if (pen.bold) parts.push("t-b");
  if (pen.italic) parts.push("t-i");
  if (pen.underline) parts.push("t-u");
  if (pen.inverse) parts.push("t-inv");
  if (isClass(pen.fg)) parts.push(pen.fg);
  if (isClass(pen.bg)) parts.push(pen.bg);
  return parts.join(" ");
}

/** @param {Pen} pen @returns {string} */
function styleOf(pen) {
  const parts = [];
  if (!isClass(pen.fg) && pen.fg) parts.push(`color:${pen.fg}`);
  if (!isClass(pen.bg) && pen.bg) parts.push(`background:${pen.bg}`);
  return parts.join(";");
}

/** @param {string} value */
function isClass(value) {
  return value.startsWith("t-");
}

/** @param {string} digits */
function parseArgs(digits) {
  if (digits.length === 0) return [];
  return digits.split(";").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** @param {number} value @param {number} low @param {number} high */
function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/** The 256 colours of an xterm terminal, as css. */
function buildPalette() {
  /** @type {string[]} */
  const colors = [];
  const base = [
    "#000000",
    "#cd0000",
    "#00cd00",
    "#cdcd00",
    "#0000ee",
    "#cd00cd",
    "#00cdcd",
    "#e5e5e5",
    "#7f7f7f",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#5c5cff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];
  for (const hex of base) colors.push(hex);

  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        colors.push(`rgb(${steps[r]},${steps[g]},${steps[b]})`);
      }
    }
  }

  for (let i = 0; i < 24; i += 1) {
    const grey = 8 + i * 10;
    colors.push(`rgb(${grey},${grey},${grey})`);
  }
  return colors;
}
