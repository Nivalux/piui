// @ts-check

/**
 * The terminal on the page: a {@link Terminal} plus the DOM that shows it.
 *
 * The emulator keeps the screen, this keeps the pixels. It measures the font,
 * works out how many lines fit, paints on the next frame rather than on every
 * chunk (a build writes faster than a browser can build spans), and turns
 * keystrokes into the bytes a tty expects.
 */

import { Terminal } from "./term.js";

/** @typedef {(bytes: string) => void} Sink */

export class TermView {
  /**
   * @param {{write: Sink, resize?: (rows: number, cols: number) => void, title?: (text: string) => void}} hooks
   * @param {{rows?: number, cols?: number}} [start]
   */
  constructor(hooks, start = { rows: 24, cols: 80 }) {
    this.hooks = hooks;
    this.term = new Terminal(start.rows ?? 24, start.cols ?? 80);
    this.dirty = false;
    this.follow = true;
    this.cell = { width: 8, height: 16 };
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
    const probe = document.createElement("span");
    probe.className = "term-probe";
    probe.textContent = "W".repeat(10);
    this.screen.append(probe);
    const width = probe.getBoundingClientRect().width / 10;
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    if (!(width > 0) || !(height > 0)) return null;
    this.cell = { width, height };

    const box = this.scroll.getBoundingClientRect();
    const cols = Math.max(2, Math.floor(box.width / width));
    const rows = Math.max(3, Math.floor(box.height / height));
    if (rows === this.term.rows && cols === this.term.cols) return null;

    this.term.resize(rows, cols);
    this.hooks.resize?.(rows, cols);
    this.paint();
    return { rows, cols };
  }

  paint() {
    const out = this.term.render();
    const signature = `${out.cursor.row}:${out.cursor.col}:${out.cursor.visible}:${out.screen.length}:${out.history.length}:${hash(out)}`;
    if (signature === this.lastPaint) return;
    this.lastPaint = signature;

    const rows = [];
    for (const line of out.history) rows.push(rowNode(line, "term-row past"));
    for (const line of out.screen) rows.push(rowNode(line, "term-row"));
    this.screen.replaceChildren(this.caret, ...rows);

    this.caret.hidden = !out.cursor.visible;
    this.caret.style.left = `${out.cursor.col * this.cell.width}px`;
    this.caret.style.top = `${out.cursor.row * this.cell.height}px`;
    this.caret.style.width = `${Math.max(1, this.cell.width)}px`;
    this.caret.style.height = `${Math.max(1, this.cell.height)}px`;

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
 */
function rowNode(line, cls) {
  const row = document.createElement("div");
  row.className = cls;
  for (const run of line) {
    const span = document.createElement("span");
    if (run.cls) span.className = run.cls;
    if (run.style) span.setAttribute("style", run.style);
    span.textContent = run.text;
    row.append(span);
  }
  return row;
}

/**
 * A cheap fingerprint of what is on the screen, so a frame that changed nothing
 * paints nothing.
 *
 * @param {{history: any[][], screen: any[][]}} out
 */
function hash(out) {
  let value = 0;
  const feed = (/** @type {any[]} */ rows) => {
    for (const line of rows) {
      for (const run of line) {
        for (let i = 0; i < run.text.length; i += 1) {
          value = (value * 31 + run.text.charCodeAt(i)) | 0;
        }
        value = (value * 31 + run.cls.length) | 0;
      }
    }
  };
  feed(out.history);
  feed(out.screen);
  return value.toString(36);
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
  // @ts-ignore indexing a lookup of known names
  const code = later[key];
  return code ? `\x1b[${code}~` : null;
}
