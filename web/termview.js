// @ts-check

/** The terminal on the page: a {@link Terminal} plus the DOM that shows it. */

import { Terminal } from "./term.js";

/** @typedef {(bytes: string) => void} Sink */

export class TermView {
  /**
   * @param {{write: Sink, resize?: (rows: number, cols: number) => void, title?: (text: string) =>
   * void}} hooks
   * @param {{rows?: number, cols?: number}} [start]
   */
  constructor(hooks, start = { rows: 24, cols: 80 }) {
    this.hooks = hooks;
    this.term = new Terminal(start.rows ?? 24, start.cols ?? 80);
    this.dirty = false;
    this.follow = true;
    this.cell = { width: 8, height: 16 };
    /** How wide one character is in the font on screen, once per character. */
    /** @type {Map<string, number>} */
    this.advances = new Map();
    this.probe = document.createElement("span");
    this.probe.className = "term-probe term-row";
    /** @type {string} */
    this.lastPaint = "";

    this.root = document.createElement("div");
    this.root.className = "term";

    this.scroll = document.createElement("div");
    this.scroll.className = "term-scroll";

    this.screen = document.createElement("div");
    this.screen.className = "term-screen";
    this.screen.setAttribute("role", "textbox");
    this.screen.setAttribute("aria-multiline", "true");
    this.screen.setAttribute("aria-label", "Terminal");

    this.caret = document.createElement("div");
    this.caret.className = "term-caret";
    this.screen.append(this.caret);

    this.scroll.append(this.screen);
    this.scroll.addEventListener("scroll", () => this.watchScroll());

    this.input = document.createElement("textarea");
    this.input.className = "term-input";
    this.input.spellcheck = false;
    this.input.autocapitalize = "off";
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-label", "Type in the terminal");

    this.root.append(this.scroll, this.input);
    this.root.addEventListener("mousedown", (event) => {
      if (window.getSelection()?.toString()) return;
      event.preventDefault();
      this.focus();
    });

    this.term.onReport = (text) => this.hooks.write(text);
    this.term.onTitle = (text) => {
      this.hooks.title?.(text);
    };

    this.wireKeys();

    // A webfont that arrives after the first paint changes every metric the grid stands on.
    document.fonts?.ready.then(() => {
      this.advances.clear();
      this.fit();
      this.paint();
    });
  }

  /** @param {string} ch */
  advance(ch) {
    const known = this.advances.get(ch);
    if (known !== undefined) return known;
    this.probe.textContent = ch.repeat(8);
    this.screen.append(this.probe);
    const width = this.probe.getBoundingClientRect().width / 8;
    this.probe.remove();
    this.probe.textContent = "";
    this.advances.set(ch, width);
    return width;
  }

  /**
   * The space to add after a character so that it fills exactly one cell. A glyph from a fallback
   * font — braille, an emoji, a character this font has never seen — is as wide as it is, and the
   * row would slide out of step with its neighbours behind it.
   *
   * @param {string} ch
   */
  pitch(ch) {
    return this.cell.width - this.advance(ch);
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  /** @param {string} text */
  write(text) {
    this.term.write(text);
    this.schedule();
  }

  /** @param {string} text */
  note(text) {
    const line = document.createElement("div");
    line.className = "term-note";
    line.textContent = text;
    this.root.append(line);
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  schedule() {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => {
      this.dirty = false;
      this.paint();
    });
  }

  /** Measure the font and give the shell the window it now has. */
  fit() {
    this.probe.textContent = "W".repeat(50);
    this.screen.append(this.probe);
    const width = this.probe.getBoundingClientRect().width / 50;
    const height = this.probe.getBoundingClientRect().height;
    this.probe.remove();
    this.probe.textContent = "";
    if (!(width > 0) || !(height > 0)) return null;
    this.cell = { width, height };
    this.advances.clear();

    // The window a shell gets is the room the text has, which is neither the border box (its
    // scrollbar would be counted twice) nor the padding (no glyph stands there).
    const inset = window.getComputedStyle(this.scroll);
    const wide = this.scroll.clientWidth - parseFloat(inset.paddingLeft) - parseFloat(inset.paddingRight);
    const tall = this.scroll.clientHeight - parseFloat(inset.paddingTop) - parseFloat(inset.paddingBottom);
    const cols = Math.max(2, Math.floor(wide / width));
    const rows = Math.max(3, Math.floor(tall / height));
    if (rows === this.term.rows && cols === this.term.cols) return null;

    this.term.resize(rows, cols);
    this.hooks.resize?.(rows, cols);
    this.paint();
    return { rows, cols };
  }

  paint() {
    const out = this.term.render();
    const painted = signature(out);
    if (painted === this.lastPaint) return;
    this.lastPaint = painted;

    const step = (/** @type {string} */ ch) => this.pitch(ch);
    const rows = [];
    for (const line of out.history) rows.push(rowNode(line, "term-row past", step));
    for (const line of out.screen) rows.push(rowNode(line, "term-row", step));
    this.screen.replaceChildren(this.caret, ...rows);

    this.caret.hidden = !out.cursor.visible;
    this.caret.classList.toggle("term-underline", out.cursor.style === "underline");
    this.caret.classList.toggle("term-bar", out.cursor.style === "bar");
    this.caret.classList.toggle("term-steady", !out.cursor.blinks);
    this.caret.style.left = `${out.cursor.col * this.cell.width}px`;
    this.caret.style.width = `${out.cursor.style === "bar" ? 2 : Math.max(1, this.cell.width)}px`;
    this.caret.style.height = `${out.cursor.style === "underline" ? 2 : Math.max(1, this.cell.height)}px`;
    this.caret.style.top =
      out.cursor.style === "underline"
        ? `${(out.cursor.row + 1) * this.cell.height - 2}px`
        : `${out.cursor.row * this.cell.height}px`;

    if (this.follow) this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  watchScroll() {
    const edge = this.scroll.scrollHeight - this.scroll.clientHeight;
    this.follow = this.scroll.scrollTop >= edge - 4;
  }

  wireKeys() {
    this.input.addEventListener("keydown", (event) => {
      const bytes = keyBytes(event);
      if (bytes === null) return;
      // The shell is the point of this window: while the caret is in it, keys
      // go down the pipe and not to the page shortcuts behind it.
      event.preventDefault();
      event.stopPropagation();
      if (bytes.length > 0) this.hooks.write(bytes);
    });
    this.input.addEventListener("input", () => {
      const text = this.input.value;
      this.input.value = "";
      if (text.length > 0) this.hooks.write(text);
    });
  }
}

/**
 * @param {{text: string, cls: string, style: string}[]} line
 * @param {string} cls
 * @param {(ch: string) => number} pitch
 */
function rowNode(line, cls, pitch) {
  const row = document.createElement("div");
  row.className = cls;
  for (const run of line) {
    let start = 0;
    while (start < run.text.length) {
      const slack = pitch(run.text.charAt(start));
      let end = start + 1;
      while (end < run.text.length && pitch(run.text.charAt(end)) === slack) end += 1;
      const span = document.createElement("span");
      if (run.cls) span.className = run.cls;
      if (run.style) span.setAttribute("style", run.style);
      if (Math.abs(slack) > 0.01) span.style.letterSpacing = `${slack}px`;
      span.textContent = run.text.slice(start, end);
      row.append(span);
      start = end;
    }
  }
  return row;
}

/**
 * A cheap fingerprint of a frame, so a frame that changed nothing paints nothing. Everything the
 * page draws rides on it: the letters, their classes, the colours they carry inline, and the caret.
 *
 * @param {{history: any[][], screen: any[][], cursor: {row: number, col: number, visible: boolean}}}
 */
export function signature(out) {
  let value = out.cursor.row * 31 + out.cursor.col + (out.cursor.visible ? 7 : 13);
  const feed = (/** @type {any[][]} */ rows) => {
    for (const line of rows) {
      for (const run of line) {
        const look = `${run.cls} ${run.style}`;
        for (let i = 0; i < run.text.length; i += 1) value = (value * 31 + run.text.charCodeAt(i)) | 0;
        for (let i = 0; i < look.length; i += 1) value = (value * 31 + look.charCodeAt(i)) | 0;
      }
      value = (value * 31 + 10) | 0;
    }
  };
  feed(out.history);
  feed(out.screen);
  return `${value.toString(36)}:${out.screen.length}:${out.history.length}`;
}

/**
 * The bytes a key sends to a tty, or null when the page should keep the key.
 *
 * @param {KeyboardEvent} event
 * @returns {string | null}
 */
export function keyBytes(event) {
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1) {
    return `\x1b${event.key}`;
  }
  if (event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.key === " ") return "\x00";
    if (event.key.length === 1) {
      const letter = event.key.toLowerCase();
      if (letter >= "a" && letter <= "z") return String.fromCharCode(letter.charCodeAt(0) - 96);
      if (letter === "[") return "\x1b";
      if (letter === "\\") return "\x1c";
      if (letter === "]") return "\x1d";
      if (letter === "_") return "\x1f";
      return null;
    }
    return null;
  }
  if (event.metaKey) return null;
  if (event.key.length > 1) return specialKey(event.key, event.shiftKey);
  return null;
}

/** @param {string} key @param {boolean} shift */
function specialKey(key, shift) {
  if (key === "Enter") return "\r";
  if (key === "Backspace") return "\x7f";
  if (key === "Tab") return shift ? "\x1b[Z" : "\t";
  if (key === "Escape") return "\x1b";
  if (key === "ArrowUp") return "\x1b[A";
  if (key === "ArrowDown") return "\x1b[B";
  if (key === "ArrowRight") return "\x1b[C";
  if (key === "ArrowLeft") return "\x1b[D";
  if (key === "Home") return "\x1b[H";
  if (key === "End") return "\x1b[F";
  if (key === "PageUp") return "\x1b[5~";
  if (key === "PageDown") return "\x1b[6~";
  if (key === "Insert") return "\x1b[2~";
  if (key === "Delete") return "\x1b[3~";
  const functionKey = ["F1", "F2", "F3", "F4"].indexOf(key);
  if (functionKey >= 0) return `\x1bO${String.fromCharCode(80 + functionKey)}`;
  const later = { F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
  // @ts-expect-error indexing a lookup of known names
  const code = later[key];
  return code ? `\x1b[${code}~` : null;
}
