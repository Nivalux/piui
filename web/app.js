// @ts-check

/** The page. */

import { Transcript } from "./transcript.js";
import { toClipboard } from "./clip.js";
import { filterCommands, knownCommands, parseCommands, parseSlash, slashRun } from "./commands.js";
import {
  ago,
  badge,
  basename,
  contextRing,
  cost,
  duration,
  firstLine,
  hintParts,
  lastLine,
  perSecond,
  relativeTime,
  shortPath,
  tokens,
  truncate,
} from "./format.js";
import { isUnread, splitTabs } from "./tabs.js";
import { Meter } from "./rate.js";
import { parseDiff } from "./diff.js";
import { toolView } from "./toolview.js";
import { markdownNode, parseMarkdown } from "./markdown.js";
import { flattenResult as flatten, imageDataUrl, isPiuiEvent, parseFrame } from "./protocol.js";
import { TermView } from "./termview.js";
import { highlight, rank } from "./filter.js";
import { chosen, splitTyping, step, suggestions } from "./dirview.js";
import {
  baseOf,
  closeFile,
  dirOf,
  fileRows,
  fileTree,
  numberLines,
  openDiff,
  openFile,
  openTerminal,
  pinView,
  statusGroups,
  trailOf,
} from "./panel.js";

/**
 * @typedef {import("./protocol.js").Frame} Frame
 * @typedef {import("./protocol.js").TabInfo} TabInfo
 * @typedef {import("./protocol.js").Ui} Ui
 * @typedef {import("./protocol.js").Command} Command
 * @typedef {import("./protocol.js").ShellInfo} ShellInfo
 * @typedef {import("./protocol.js").PiModel} PiModel
 * @typedef {import("./transcript.js").Block} Block
 *
 * @typedef {{id: string, path: string, name?: string | null, cwd?: string | null, created?: string
 * | null, updated?: string | null, first_text?: string | null, messages: number, running:
 * boolean}} SessionEntry
 *
 * @typedef {{
 *   base: string;
 *   label: string;
 *   branch: string;
 *   ahead: number;
 *   behind: number;
 *   insertions: number;
 *   deletions: number;
 *   files: import("./panel.js").Changed[];
 *   truncated: boolean;
 *   errorMessage?: string | null;
 * }} GitStatus
 *
 * @typedef {import("./panel.js").View} View
 *
 * @typedef {{path: string, text: string, size: number, truncated: boolean, binary: boolean}}
 * FileContent
 */

const ids = {
  gate: "gate",
  gateForm: "gate-form",
  gateToken: "gate-token",
  gateError: "gate-error",
  gateWait: "gate-wait",
  gateWaitTime: "gate-wait-time",
  shell: "shell",
  tabs: "tab-list",
  sessions: "session-list",
  sessionProject: "session-project",
  filter: "filter",
  newChat: "new-chat",
  newProject: "new-project",
  newItem: "new-item",
  terminal: "terminal",
  title: "tab-title",
  cwd: "tab-cwd",
  branch: "branch",
  base: "base",
  kill: "kill",
  sidebarToggle: "sidebar-toggle",
  sidePanel: "side-panel",
  work: "work",
  panelToggle: "panel-toggle",
  panelClose: "panel-close",
  panelDiffTab: "panel-diff-tab",
  panelFilesTab: "panel-files-tab",
  panelDiff: "panel-diff",
  panelFiles: "panel-files",
  fileFilter: "file-filter",
  fileCrumbs: "file-crumbs",
  fileList: "file-list",
  diffHead: "diff-head",
  diffBody: "diff-body",
  views: "view-tabs",
  stream: "stream",
  composer: "composer",
  fileView: "file-view",
  fileHead: "file-head",
  fileBody: "file-body",
  transcript: "transcript",
  lightbox: "lightbox",
  lightboxImg: "lightbox-img",
  jump: "jump",
  attachments: "attachments",
  attach: "attach",
  attachInput: "attach-input",
  queue: "queue",
  palette: "palette",
  input: "input",
  status: "status",
  rate: "rate",
  context: "context",
  contextRing: "context-ring",
  contextPct: "context-pct",
  busy: "busy",
  busyTime: "busy-time",
  model: "model",
  thinking: "thinking",
  send: "send",
  abort: "abort",
  offline: "offline",
  meterBar: "meter-bar",
  askModal: "ask-modal",
  settingsButton: "settings-button",
  settingsModal: "settings-modal",
  dirModal: "dir-modal",
  toast: "toast",
};

/** @type {Record<string, any>} */
const el = {};
for (const [key, id] of Object.entries(ids)) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`felt #${id}`);
  el[key] = node;
}

/**
 * @type {{tabs: TabInfo[], active: string | null, shells: ShellInfo[], sessions: SessionEntry[], commands: Command[], ui: Ui,
 *   base: string, model: string, modelKey: string, models: PiModel[], thinking: string, thinkingDefault: string,
 *   thinkingLevels: string[], thinkingChoice: string, connected: boolean, queued: number, offline: boolean,
 *   build: string,
 *   context: {used: number, size: number}, follow: boolean,
 *   views: View[], activeView: number, panel: "diff" | "files",
 *   files: {path: string}[], filesTruncated: boolean, lastChat: string}}
 */
const state = {
  tabs: [],
  active: null,
  /** The last chat that was in view, so closing a terminal returns to where the
   * reader came from instead of to whichever chat the list happens to start on. */
  lastChat: "",
  /** Terminal windows the server is holding open. @type {import("./protocol.js").ShellInfo[]} */
  shells: [],
  sessions: [],
  commands: [],
  ui: {},
  base: "working",
  model: "",
  modelKey: "",
  models: [],
  thinking: "",
  thinkingDefault: "",
  thinkingLevels: [],
  thinkingChoice: "default",
  connected: false,
  /** How many messages Pi is still holding for the chat in view. */
  queued: 0,
  /** The whole server is gone, not just this chat's stream. */
  offline: false,
  /** Which build of the frontend this page arrived with. */
  build: "",
  context: { used: 0, size: 0 },
  follow: true,
  /**
   * What the main area holds: the chat first, then every file opened from the
   * panel. Index 0 is never closed, so there is always a way back.
   *
   * @type {View[]}
   */
  views: [{ kind: "chat" }],
  activeView: 0,
  /** Which half of the side panel is up. */
  panel: /** @type {"diff" | "files"} */ ("diff"),
  /** @type {{path: string}[]} */
  files: [],
  filesTruncated: false,
};

const transcript = new Transcript();
const meter = new Meter();

/** @type {EventSource | null} */
let stream = null;
/** @type {Map<number, HTMLElement>} */
const painted = new Map();
/** @type {Map<number, string>} */
const signatures = new Map();
/** @type {Map<number, boolean>} block id → whether the reader left this fold open */
const folds = new Map();
/** @type {HTMLElement | null} the transcript row the pointer is currently down on */
let pressed = null;
/** @type {{entryId: string, text: string}[]} */
let forkMessages = [];
let forkStamp = 0;
/** Which sidebar chat groups are unfolded. */
const groups = /** @type {Record<string, boolean>} */ ({ Working: true, Settled: true });

/** Why each chat stopped, as this page heard it: id → what pi said. */
const endings = new Map();

/**
 * When the reader last looked at each chat, kept between visits so a run that
 * finished while they were elsewhere is still waiting for them after a reload.
 *
 * @type {Record<string, number>}
 */
const seen = readSeen();

function readSeen() {
  try {
    return /** @type {Record<string, number>} */ (JSON.parse(localStorage.getItem("piui:seen") ?? "{}"));
  } catch {
    return {};
  }
}

/** @param {string} id */
function markSeen(id) {
  seen[id] = Date.now();
  localStorage.setItem("piui:seen", JSON.stringify(seen));
}

/**
 * An answer that arrived with its own chat on the screen was read the moment it landed, so the row
 * of a chat nobody has to click back to is not marked. Only what finished out of sight is waiting.
 */
function markOpenChatRead() {
  const tab = active();
  if (!tab || document.visibilityState !== "visible") return;
  const ended = Number(tab.finishedMs) || 0;
  if (ended <= (Number(seen[tab.id]) || 0)) return;
  seen[tab.id] = ended;
  localStorage.setItem("piui:seen", JSON.stringify(seen));
}
/** Folder the session list is narrowed to, `all` for everything. */
let sessionProject = "all";
/** Folders whose full session list the reader asked for. */
const expanded = new Set();
/** Sessions per folder before a "+n more" appears. */
const perProject = 6;
/** @type {{type: "image", data: string, mimeType: string}[]} */
const attachments = [];
/** @type {GitStatus | null} */
let status = null;

let paletteIndex = 0;
let scheduled = false;

boot().catch((err) => {
  // A half-wired page looks like a dead page; say what broke instead.
  const pre = element("pre", "boot-error", String(err?.stack ?? err));
  document.body.append(pre);
});

async function boot() {
  const health = await getJSON("/api/health").catch(() => null);
  state.build = typeof health?.build === "string" ? health.build : "";

  if (health) {
    if (health.signedIn) localStorage.setItem("piui:signed", "1");
    else localStorage.removeItem("piui:signed");
  }

  if (!health?.signedIn) {
    // No answer is not a wrong token. A browser that has signed in before knows
    // it, and being asked for a token it already has is a bad way to find out
    // that the server is merely not up yet.
    if (!health && localStorage.getItem("piui:signed") === "1") return waitForServer();
    const ok = await askForToken();
    if (!ok) return;
    localStorage.setItem("piui:signed", "1");
  }

  el.shell.hidden = false;
  el.gate.remove();

  wire();
  void watchServer();
  setInterval(() => void watchServer(), 2000);
  await loadSettings();
  await loadTabs();
  await loadShells();
  poll();

  const remembered = localStorage.getItem("piui:tab");
  const first = state.tabs.find((tab) => tab.id === remembered) ?? state.tabs[0];
  if (first) return openTab(first.id);

  // A restart kills the Pi processes but not the sessions they were in: put back
  // every chat that was open, oldest first, so the one last looked at ends up on
  // screen. Each one costs a Pi process, so a very long list gets trimmed.
  /** @type {{cwd: string, session?: string}[]} */
  const saved = ((await getJSON("/api/restore").catch(() => [])) ?? []).slice(-8);
  for (const item of saved) {
    await createTab(item.session ? { cwd: item.cwd, session: item.session } : { cwd: item.cwd }).catch(() => {});
  }
  if (state.active) return;

  showEmptyState();
  await loadSessions();
}

/**
 * A page with no tab open looks broken: empty pane, empty pickers, a composer
 * that swallows what you type. Say what is missing and offer the way in.
 */
function showEmptyState() {
  el.transcript.replaceChildren();

  const box = element("div", "empty-chat");
  box.append(
    element("p", "empty-title", "No chat open"),
    element("p", "empty-hint", "Start one here, or pick a session from the list on the left."),
  );

  const button = element("button", "button primary", "New chat");
  button.onclick = () => void createTab({});
  box.append(button);

  el.transcript.append(box);
}

// ---------------------------------------------------------------- fetching

class AuthError extends Error {}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function request(path, init) {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (response.status === 401) throw new AuthError();
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response;
}

/** @param {string} path */
async function getJSON(path) {
  return jsonOf(await request(path));
}

/**
 * @param {string} path
 * @param {unknown} body
 */
async function postJSON(path, body) {
  return jsonOf(
    await request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** @param {Response} response */
async function jsonOf(response) {
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : null;
}

// ----------------------------------------------------------------- sign-in

/** The gate waits for the token once; the cookie then does the rest. */
/**
 * Signed in, server not there. Say which of the two is missing and keep asking;
 * the first answer reloads the page into the app.
 *
 * @returns {Promise<boolean>}
 */
function waitForServer() {
  el.gate.hidden = false;
  el.gateForm.hidden = true;
  el.gateWait.hidden = false;

  const began = Date.now();
  const count = setInterval(() => {
    el.gateWaitTime.textContent = `still asking · ${duration(Date.now() - began)}`;
  }, 1000);

  const ask = setInterval(async () => {
    const health = await getJSON("/api/health").catch(() => null);
    if (!health) return;
    clearInterval(ask);
    clearInterval(count);
    location.reload();
  }, 1500);

  return new Promise(() => {});
}

function askForToken() {
  el.gate.hidden = false;
  el.gateToken.focus();

  return new Promise((resolve) => {
    el.gateForm.onsubmit = async (/** @type {Event} */ event) => {
      event.preventDefault();
      const value = String(el.gateToken.value).trim();
      if (value.length === 0) return;

      try {
        await postJSON("/api/login", { token: value });
        resolve(true);
      } catch (error) {
        el.gateError.hidden = false;
        el.gateError.textContent = error instanceof AuthError ? "wrong token" : "server unreachable";
        el.gateToken.select();
      }
    };
  });
}

// -------------------------------------------------------------------- wire

function wire() {
  el.newChat.onclick = () => void createTab({});
  el.newProject.onclick = () => void createProject();
  el.newItem.onclick = () => void openTerminalTab(active());
  el.dirModal.onclick = /** @param {MouseEvent} event */ (event) => {
    if (event.target === el.dirModal) el.dirModal.hidden = true;
  };
  el.askModal.onclick = /** @param {MouseEvent} event */ (event) => {
    if (event.target === el.askModal) answerAsk(false);
  };
  el.settingsModal.onclick = /** @param {MouseEvent} event */ (event) => {
    if (event.target === el.settingsModal) el.settingsModal.hidden = true;
  };
  el.lightbox.onclick = () => hideShot();
  el.tabs.addEventListener("pointerdown", () => {
    pressingTabs = true;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(releaseTabs, 5000);
  });
  for (const done of ["click", "pointercancel"]) {
    window.addEventListener(done, () => setTimeout(releaseTabs, 0), true);
  }
  // Anywhere else on the page dismisses an open row menu; the ⋯ and its items
  // stop their own clicks, so this only ever sees a click outside of it.
  document.addEventListener("click", () => {
    closeMenuButton();
    if (baseMenu) closeBaseMenu();
  });
  // Escape closes the picker wherever the page happens to have put the caret.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || el.dirModal.hidden) return;
    event.preventDefault();
    el.dirModal.hidden = true;
  });
  el.filter.oninput = () => renderSidebar();
  el.filter.onkeydown = /** @param {KeyboardEvent} event */ (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    el.filter.value = "";
    renderSidebar();
    el.filter.blur();
  };
  window.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const field = /** @type {HTMLElement | null} */ (/** @type {EventTarget | null} */ (event.target));
    if (field?.tagName === "INPUT" || field?.tagName === "TEXTAREA" || field?.isContentEditable) return;
    event.preventDefault();
    el.filter.focus();
    el.filter.select();
  });
  el.transcript.onscroll = () => watchScroll();
  el.jump.onclick = () => jumpToEnd();
  el.sessionProject.onchange = () => {
    sessionProject = String(el.sessionProject.value);
    expanded.clear();
    renderSidebar();
  };
  el.base.onclick = /** @param {MouseEvent} event */ (event) => {
    event.stopPropagation();
    openBaseMenu(el.base);
  };
  el.branch.onclick = /** @param {MouseEvent} event */ (event) => {
    event.stopPropagation();
    openBaseMenu(el.branch);
  };
  el.sidebarToggle.onclick = () => void saveUi({ sidebar: state.ui.sidebar === false });
  el.panelToggle.onclick = () => void togglePanel();
  el.panelClose.onclick = () => void setPanel(false);
  el.panelDiffTab.onclick = () => setPanelTab("diff");
  el.panelFilesTab.onclick = () => setPanelTab("files");
  el.fileFilter.oninput = () => renderFileList();
  el.fileFilter.onkeydown = /** @param {KeyboardEvent} event */ (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    el.fileFilter.value = "";
    renderFileList();
  };
  // Escape gives back the space the panel took. Something smaller may be
  // holding the key first: a modal, the command palette, or a field that is
  // being typed in, and each of those keeps it.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (rowMenu) {
      event.preventDefault();
      closeMenuButton();
      return;
    }
    if (!el.lightbox.hidden) {
      event.preventDefault();
      hideShot();
      return;
    }
    if (!el.askModal.hidden) {
      event.preventDefault();
      answerAsk(false);
      return;
    }
    if (!el.settingsModal.hidden) {
      event.preventDefault();
      el.settingsModal.hidden = true;
      return;
    }
    if (!el.askModal.hidden || !el.dirModal.hidden || !el.palette.hidden) return;
    const field = /** @type {HTMLElement | null} */ (/** @type {EventTarget | null} */ (event.target));
    if (field && (field.tagName === "INPUT" || field.tagName === "TEXTAREA" || field.isContentEditable)) return;
    escapePanel();
  });
  // Two panels the reader keeps wanting back: Ctrl+B for the chat list, Ctrl+J
  // for files and diff. Both are one click, but that click is a hundred a day.
  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    // Ctrl+B is the chat list and Ctrl+J the panel, but Ctrl+B is also "go back"
    // in a shell. Whoever is typing in a terminal keeps both.
    if (event.target instanceof Element && event.target.closest(".term")) return;
    if (event.key === "b" || event.key === "B") {
      event.preventDefault();
      void saveUi({ sidebar: state.ui.sidebar === false });
    }
    if (event.key === "j" || event.key === "J") {
      event.preventDefault();
      void togglePanel();
    }
  });
  el.send.onclick = () => void send();
  el.abort.onclick = () => void interrupt();
  el.settingsButton.onclick = () => void showSettings();
  el.kill.onclick = () => void closeTab();
  el.model.onchange = () => void pickModel();
  el.thinking.onchange = () => pickThinking();

  for (const node of el.shell.querySelectorAll(".spinner")) turnTo(node);

  window.addEventListener("pointerdown", (event) => {
    pressed = event.target instanceof Element ? event.target.closest(".block") : null;
  });
  window.addEventListener("pointerup", () => {
    pressed = null;
  });
  window.addEventListener("pointercancel", () => {
    pressed = null;
  });
  window.addEventListener("blur", () => {
    pressed = null;
  });

  el.input.addEventListener("keydown", onKey);
  el.input.addEventListener("input", () => {
    grow();
    syncPalette();
  });
  el.input.addEventListener("paste", onPaste);
  el.attach.onclick = () => el.attachInput.click();
  el.attachInput.onchange = () => {
    attachFiles([...(el.attachInput.files ?? [])]);
    el.attachInput.value = "";
  };

  el.composer.addEventListener("dragover", onDragOver);
  el.composer.addEventListener("dragleave", onDragLeave);
  el.composer.addEventListener("drop", onDrop);

  renderTight();
  new ResizeObserver(() => renderTight()).observe(el.work);

  window.addEventListener("beforeunload", () => stream?.close());
}

/**
 * The chat and the panel want the same pixels. A chat squeezed to a column of
 * nothing is worse than no panel at all, so the panel steps aside while the
 * room cannot hold both and steps back without being asked when it can. The
 * saved setting is left alone: this is the window's fault, not the user's.
 */
function renderTight() {
  const wanted =
    Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--files-width"), 10) || 340;
  el.shell.classList.toggle("tight", !el.sidePanel.hidden && el.work.clientWidth < wanted + 360);
}

/** @param {KeyboardEvent} event */
function onKey(event) {
  if (!el.palette.hidden) {
    if (event.key === "ArrowDown") return stepPalette(1, event);
    if (event.key === "ArrowUp") return stepPalette(-1, event);
    if (event.key === "Tab" || (event.key === "Enter" && paletteIndex >= 0)) return acceptPalette(event);
    if (event.key === "Escape") return hidePalette(event);
  }

  if (event.key === "Enter" && !event.shiftKey && state.ui.send_on_enter !== false) {
    event.preventDefault();
    void send();
  }
}

// -------------------------------------------------------------------- tabs

async function loadTabs() {
  const list = await getJSON("/api/tabs");
  state.tabs = Array.isArray(list) ? list : [];
  renderSidebar();
}

// ---------------------------------------------------------------- terminals

/**
 * A terminal belongs to a chat and is looked at the way a diff is: as a view
 * beside it, not as a row of its own in the sidebar. The server numbers shells
 * s1, s2… and chats t1, t2…, so the two never collide.
 */

/** What each shell called itself, from the title escape it last sent. */
const shellTitles = new Map();

async function loadShells() {
  const answer = await getJSON("/api/pty").catch(() => null);
  state.shells = Array.isArray(answer?.shells) ? answer.shells : [];
  renderViews();
}

/**
 * Open a shell in `cwd`, on the chat in front of the reader. Everything else
 * on the page hangs off a chat, so a terminal asked for while none is open
 * starts one first and lands beside it.
 *
 * @param {string} cwd
 */
async function createShell(cwd) {
  const mine = state.active ?? (await createTab({ cwd }));
  if (!mine) return;
  try {
    const answer = await postJSON("/api/pty", { cwd, tab: mine });
    const shell = answer?.shell;
    if (!shell?.id) return toast("the terminal did not open");
    state.shells = [shell, ...state.shells.filter((item) => item.id !== shell.id)];
    openTerminalView(shell.id);
  } catch (error) {
    toast(error instanceof Error ? error.message : "could not open a terminal");
  }
}

/** @param {string} shell */
function openTerminalView(shell) {
  const next = openTerminal(state.views, shell);
  state.views = next.views;
  showView(next.active);
}

/** The terminals of one chat, as views.
 * @param {string} id
 * @returns {import("./panel.js").TerminalView[]}
 */
function terminalViews(id) {
  return state.shells.filter((shell) => shell.tab === id).map((shell) => ({ kind: "terminal", shell: shell.id }));
}

/** @param {string} id */
function shellCwd(id) {
  return state.shells.find((shell) => shell.id === id)?.cwd ?? "";
}

/**
 * A terminal in the folder of the chat it was opened from, or in one asked for when
 * that chat has no folder of its own.
 *
 * @param {TabInfo | null} tab
 */
function openTerminalTab(tab) {
  const cwd = tab && isProjectCwd(tab.cwd) ? tab.cwd : "";
  if (cwd) return void createShell(cwd);
  openTerminalPicker();
}

/** The same folder picker +Project uses, with the terminal as the answer. */
function openTerminalPicker() {
  picker.onChoose = (cwd) => void createShell(cwd);
  void createProject();
}

/**
 * Close a terminal for good. A view of a shell is the only thing holding it,
 * so the process goes with the tab that was opened for it.
 *
 * @param {string} id
 */
async function closeShell(id) {
  await request(`/api/pty?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  dropShell(id);

  const at = state.views.findIndex((view) => view.kind === "terminal" && view.shell === id);
  if (at <= 0) return renderViews();
  const next = closeFile(state.views, state.activeView, at);
  state.views = next.views;
  showView(next.active);
}

/** Forget everything this page holds about a shell that is gone. @param {string} id */
function dropShell(id) {
  shellStreams.get(id)?.close();
  shellStreams.delete(id);
  shellViews.get(id)?.root.remove();
  shellViews.delete(id);
  observers.get(id)?.disconnect();
  observers.delete(id);
  shellTitles.delete(id);
  state.shells = state.shells.filter((shell) => shell.id !== id);
  renderViews();
}

/** @param {string} id @returns {import("./termview.js").TermView} */
function shellViewFor(id) {
  const seen = shellViews.get(id);
  if (seen) return seen;

  const view = new TermView({
    write: (bytes) => void shellWrite(id, bytes),
    resize: (rows, cols) => void shellResize(id, rows, cols),
    title: (text) => {
      if (!text) return;
      shellTitles.set(id, text);
      renderViews();
    },
    copied: () => toast("Copied!", 1200),
  });
  el.terminal.append(view.root);
  shellViews.set(id, view);

  const watch = new ResizeObserver(() => {
    if (view.root.hidden) return;
    view.fit();
  });
  watch.observe(view.scroll);
  observers.set(id, watch);

  attachShell(id);
  return view;
}

/**
 * One stream per terminal, opened the first time it is looked at and kept open
 * after that: output keeps landing in its screen while the reader is somewhere
 * else, so coming back shows what ran.
 *
 * @param {string} id
 */
function attachShell(id) {
  if (shellStreams.has(id)) return;

  const source = new EventSource(`/api/pty/events?id=${encodeURIComponent(id)}`);
  const decoder = new TextDecoder("utf-8");
  shellStreams.set(id, source);

  // The server frames everything as a plain `data:` line and says what it is
  // inside the json, the same way the chat stream does.
  source.onmessage = (event) => {
    const frame = parseFrame(String(event.data ?? ""));
    if (!frame || (frame.event !== "shellOut" && frame.event !== "shellExit")) return;

    if (frame.event === "shellOut") {
      const view = shellViews.get(id);
      if (!view) return;
      const payload = typeof frame.data === "string" ? frame.data : "";
      if (payload.length === 0) return;
      view.write(decoder.decode(base64Bytes(payload), { stream: true }));
      return;
    }

    const code = Number(frame.code);
    const view = shellViews.get(id);
    view?.note(Number.isInteger(code) && code === 0 ? "the shell closed" : `the shell closed · code ${code}`);
    const known = state.shells.find((shell) => shell.id === id);
    if (known) known.closed = true;
    source.close();
    shellStreams.delete(id);
    renderViews();
  };
}

/** @param {string} id @param {string} bytes */
async function shellWrite(id, bytes) {
  await request(`/api/pty/write?id=${encodeURIComponent(id)}`, { method: "POST", body: bytes }).catch(() => {});
}

/** @param {string} id @param {number} rows @param {number} cols */
async function shellResize(id, rows, cols) {
  const where = `id=${encodeURIComponent(id)}&rows=${rows}&cols=${cols}`;
  await request(`/api/pty/resize?${where}`, { method: "POST" }).catch(() => {});
}

/** @param {string} text @returns {Uint8Array} */
function base64Bytes(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Bring one terminal window to the front. Its stream stays open while it is
 * hidden, so output produced elsewhere is there when the view comes back.
 *
 * @param {string} id
 */
function showShell(id) {
  for (const [key, view] of shellViews) view.root.hidden = key !== id;
  const view = shellViewFor(id);
  view.fit();
  view.paint();
  view.focus();
}

/**
 * Past chats, for resuming. Everything comes back and the sidebar narrows it by
 * folder, so switching tabs never has to refetch.
 */
async function loadSessions() {
  const list = await getJSON("/api/sessions").catch(() => null);
  state.sessions = Array.isArray(list) ? list : [];
  renderSidebar();
}

/** Keep the sidebar honest about the tabs that are not streaming here. */
function poll() {
  let ticks = 0;
  setInterval(() => {
    if (document.hidden) return;
    void loadTabs();
    void loadShells();
    if (ticks++ % 6 !== 0) return;
    void loadSessions();
  }, 5000);
}

/**
 * The folder picker. The field holds the path a new chat will run in and the
 * rows underneath complete it: typing filters the folders of the directory the
 * path names, the arrows choose one, return takes it.
 */
const picker = {
  base: "",
  needle: "",
  dirs: /** @type {{name: string, path: string}[]} */ ([]),
  rows: /** @type {{name: string, path: string}[]} */ ([]),
  cursor: -1,
  /** Set when the folder is wanted for something other than a chat. */
  onChoose: /** @type {((cwd: string) => void) | null} */ (null),
};

/** Every terminal the page has drawn, by shell number. */
const shellViews = new Map();
/** @type {Map<string, EventSource>} */
const shellStreams = new Map();
/** @type {Map<string, ResizeObserver>} */
const observers = new Map();

/** @type {{field: HTMLInputElement, list: HTMLElement} | null} */
let pickerNodes = null;

async function createProject() {
  el.dirModal.hidden = false;
  const listing = await readDirs(null);
  if (!listing) return;
  picker.base = String(listing.path ?? "");
  picker.dirs = foldersOf(listing);
  picker.needle = "";
  picker.cursor = -1;
  renderPicker(`${picker.base}/`);
}

/** @param {string | null} path */
async function readDirs(path) {
  try {
    return await getJSON(path === null ? "/api/dirs" : `/api/dirs?path=${encodeURIComponent(path)}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "cannot read that folder");
    return null;
  }
}

/** @param {any} listing */
function foldersOf(listing) {
  const list = Array.isArray(listing?.dirs) ? listing.dirs : [];
  return list.map((/** @type {any} */ dir) => ({ name: String(dir?.name ?? ""), path: String(dir?.path ?? "") }));
}

/** @param {string} value */
function renderPicker(value) {
  const field = /** @type {HTMLInputElement} */ (element("input", "dir-field"));
  field.id = "dir-field";
  field.type = "text";
  field.spellcheck = false;
  field.autocapitalize = "off";
  field.autocomplete = "off";
  field.value = value;
  field.oninput = () => void pickTyped(field.value);
  field.onkeydown = /** @param {KeyboardEvent} event */ (event) => void pickKey(event, field);

  const list = element("div", "dir-list");
  list.id = "dir-list";
  pickerNodes = { field, list };

  const buttons = element("div", "row-buttons");
  buttons.append(
    button("Use this folder", () => void pickChosen(field.value)),
    button("Cancel", () => {
      el.dirModal.hidden = true;
    }),
  );

  el.dirModal.replaceChildren(
    card(
      "New project",
      field,
      element("div", "dir-hint", "↑↓ folder · ⏎ into a folder, or start the chat here · esc cancel"),
      list,
      buttons,
    ),
  );

  renderFolders();
  field.focus();
  field.setSelectionRange(value.length, value.length);
}

/** @param {string} value */
async function pickTyped(value) {
  const { base, needle } = splitTyping(value);
  picker.needle = needle;
  picker.cursor = -1;
  if (base === picker.base) return renderFolders();

  const listing = await readDirs(base);
  // The reader may have moved on while this was in flight. A listing of the
  // folder they left must not paint over the one they are standing in.
  if (!listing || splitTyping(pickerNodes?.field.value ?? "").base !== base) return;
  picker.base = String(listing.path ?? base);
  picker.dirs = foldersOf(listing);
  renderFolders();
}

/**
 * @param {KeyboardEvent} event
 * @param {HTMLInputElement} field
 */
async function pickKey(event, field) {
  if (event.key === "Escape") {
    event.preventDefault();
    el.dirModal.hidden = true;
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    picker.cursor = step(picker.rows.length, picker.cursor, event.key === "ArrowDown" ? 1 : -1);
    renderFolders();
    return;
  }

  if (event.key !== "Enter") return;
  event.preventDefault();

  const row = picker.cursor >= 0 ? picker.rows[picker.cursor] : null;
  if (!row) return pickChosen(field.value);
  field.value = `${row.path}/`;
  await pickTyped(field.value);
  field.focus();
}

/** @param {string} typed */
async function pickChosen(typed) {
  const cwd = chosen(picker.rows, picker.cursor, typed);
  el.dirModal.hidden = true;

  const wanted = picker.onChoose;
  picker.onChoose = null;
  if (wanted) return wanted(cwd);
  await createTab({ cwd });
}

function renderFolders() {
  if (!pickerNodes) return;

  const hits = suggestions(picker.dirs, picker.needle);
  picker.rows = hits.map((hit) => hit.item);
  if (picker.cursor >= picker.rows.length) picker.cursor = picker.rows.length - 1;

  const nodes = hits.map((hit, index) => {
    const row = element("div", `dir-row${index === picker.cursor ? " on" : ""}`);
    row.dataset.path = hit.item.path;
    row.append(span("▸", "dir-glyph"), highlight(hit.item.name, hit.ranges, "b"));
    row.onclick = () => void pickRow(hit.item.path);
    row.ondblclick = () => void pickChosen(hit.item.path);
    return row;
  });

  pickerNodes.list.replaceChildren(...nodes);
  if (nodes.length === 0) pickerNodes.list.append(element("div", "dir-empty", "no folder matches"));
  const on = picker.cursor >= 0 ? nodes[picker.cursor] : undefined;
  if (on) on.scrollIntoView({ block: "nearest" });
}

/** @param {string} path */
async function pickRow(path) {
  if (!pickerNodes) return;
  pickerNodes.field.value = `${path}/`;
  await pickTyped(pickerNodes.field.value);
  pickerNodes.field.focus();
}

/**
 * Open a chat. `recreate` is the one case in which piui makes a folder: a reader who was shown
 * that a chat's folder is gone and asked for it back.
 *
 * @param {{cwd?: string, session?: string, recreate?: boolean}} body
 */
async function createTab(body) {
  try {
    const tab = await postJSON("/api/tab", body);
    state.tabs = [tab, ...state.tabs.filter((item) => item.id !== tab.id)];
    renderSidebar();
    await openTab(tab.id);
    return /** @type {string} */ (tab.id);
  } catch (error) {
    toast(error instanceof Error ? error.message : "could not open a tab");
    return "";
  }
}

/**
 * Look at one chat: its transcript, its files, its terminals.
 *
 * @param {string} id
 */
async function openTab(id) {
  state.active = id;
  localStorage.setItem("piui:tab", id);
  markSeen(id);

  stream?.close();
  stream = null;
  transcript.clear();
  meter.reset();
  painted.clear();
  signatures.clear();
  renderQueue();
  el.transcript.replaceChildren();
  state.follow = true;
  el.jump.hidden = true;

  state.views = [{ kind: "chat" }, ...terminalViews(id)];
  state.files = [];
  state.filesTruncated = false;
  filesDir = "";
  showView(0);

  const tab = active();
  el.title.textContent = tab ? labelOf(tab) : "";
  el.cwd.textContent = tab ? tab.cwd : "";

  state.model = "";
  state.modelKey = "";
  state.models = [];
  state.context = { used: 0, size: 0 };
  state.thinking = "";
  state.thinkingDefault = "";
  state.thinkingLevels = [];
  state.thinkingChoice = "default";

  connect(id);
  render();
  void refreshGit();
  void loadSessions();
}

/** @param {string} id */
function connect(id) {
  const source = new EventSource(`/api/events?id=${encodeURIComponent(id)}`);
  stream = source;

  source.onopen = () => {
    state.connected = true;
    // One mode, the one the reader chose, and it takes everything the reader
    // queued at once rather than one message per completed turn: two thoughts
    // typed in a row belong to one instruction, and answering them one at a time
    // means the second waits for a whole turn of work it already knew about.
    void sendCommand({ type: steeringCommand(), mode: "all" });
    ask("get_state");
    ask("get_commands");
    ask("get_messages");
    ask("get_fork_messages");
    ask("get_available_models");
    ask("get_available_thinking_levels");
    ask("get_session_stats");
    renderFooter();
  };

  source.onerror = () => {
    state.connected = false;
    source.close();
    renderFooter();
    if (state.active !== id) return;

    // A retry is right for a network hiccup and wrong for a chat that is gone:
    // the page would keep knocking on a door that was removed. EventSource
    // cannot see the status, so the tab list decides.
    void getJSON("/api/tabs")
      .then((list) => {
        if (state.active !== id) return;
        const tabs = Array.isArray(list) ? list : [];
        if (tabs.some((tab) => tab.id === id)) return void setTimeout(() => connect(id), 2000);

        state.tabs = tabs;
        state.active = null;
        const next = tabs[0];
        if (next) return void openTab(next.id);
        showEmptyState();
        void loadSessions();
      })
      .catch(() => setTimeout(() => connect(id), 2000));
  };

  source.onmessage = (message) => {
    const frame = parseFrame(String(message.data));
    if (frame) handle(frame);
  };
}

/**
 * Whether the server is still there at all.
 *
 * While it is gone the page keeps everything it has: the chat, the draft, the
 * panels. Coming back is automatic, and a reload only happens when the server
 * is running different code than the one this page was written against — a
 * tab that survived a restart would otherwise keep an old script forever.
 */
async function watchServer() {
  const health = await getJSON("/api/health").catch(() => null);
  if (!health) {
    if (!state.offline) {
      state.offline = true;
      renderOffline();
    }
    return;
  }

  const build = typeof health.build === "string" ? health.build : "";
  if (state.build.length > 0 && build.length > 0 && build !== state.build) {
    location.reload();
    return;
  }

  if (state.offline) {
    state.offline = false;
    renderOffline();
  }
}

function renderOffline() {
  el.offline.hidden = !state.offline;
}

/**
 * Ask pi for something over the tab's command pipe.
 *
 * @param {string} type
 */
function ask(type) {
  void sendCommand({ type });
}

/** @param {Record<string, unknown>} command */
async function sendCommand(command) {
  if (!state.active) return;
  try {
    await postJSON(`/api/cmd?id=${encodeURIComponent(state.active)}`, command);
  } catch (error) {
    toast(error instanceof Error ? error.message : "command failed");
  }
}

/** @param {Frame} frame */
function handle(frame) {
  if (isPiuiEvent(frame)) {
    if (frame.event === "running") {
      const tab = active();
      if (tab) tab.running = frame.running === true;
      render();
    } else if (frame.event === "tab") {
      replaceTab(frame.tab);
      render();
    } else if (frame.event === "closed") {
      const why = frame.reason || "closed";
      const detail = frame.stderr ? `: ${String(frame.stderr).slice(-200)}` : "";
      toast(why === "closed by user" ? "Tab closed" : `Pi exited (${why})${detail}`, 8000);
      if (frame.stderr) console.warn(frame.stderr);
      endings.set(state.active ?? "", frame.stderr ? String(frame.stderr).slice(-600) : why);
      const tab = state.tabs.find((item) => item.id === state.active);
      if (tab) tab.closed = true;
      // Nothing follows an ending. Left open, the browser would reconnect to a chat that has said
      // its last word and be told the same thing forever.
      stream?.close();
      stream = null;
      renderFooter();
      renderSidebar();
    }
    return;
  }

  // The first frame of a stream is a bare TabInfo, without a type at all.
  if (!frame.type && frame.id) {
    replaceTab(/** @type {TabInfo} */ (/** @type {unknown} */ (frame)));
    render();
    return;
  }

  if (frame.type === "thinking_level_changed" && typeof frame.level === "string") {
    state.thinking = frame.level;
    if (state.thinkingChoice !== "default") state.thinkingChoice = frame.level;
    renderPickers();
  }

  if (frame.type === "response") return response(frame);

  if (frame.type === "agent_start") meter.start();
  if (frame.type === "agent_settled") {
    meter.stop();
    void loadTabs();
  }
  if (frame.type === "message_start" && frame.message?.role === "assistant") turnStartedAt = Date.now();
  if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") {
    meter.addText(frame.assistantMessageEvent.delta ?? "");
  }
  if (frame.type === "message_end" && frame.message?.role === "assistant") {
    meter.addUsage(frame.message.usage);
    meter.turn(frame.message.usage?.output ?? 0, Date.now() - turnStartedAt);
  }
  if (frame.type === "queue_update") {
    heldQueues.set(state.active ?? "", {
      steering: strings(frame.steering),
      followUp: strings(frame.followUp),
    });
    // Pi has just said exactly what it holds, so a count from before that says
    // nothing any more.
    state.queued = 0;
    renderQueue();
  }

  if (frame.type === "session_info_changed") {
    const tab = active();
    if (tab) tab.sessionName = frame.name ?? null;
    renderSidebar();
  }

  if (frame.type === "message_start" && frame.message?.role === "user") ask("get_fork_messages");

  retirePending(frame);
  if (transcript.event(frame)) markDirty();
  // Pi only knows what the next request will cost once a turn is through, and one
  // answer can run several turns: asking at every one of them is what keeps the
  // context ring moving during a long answer rather than only at its end.
  if (frame.type === "agent_settled" || frame.type === "turn_end") {
    ask("get_session_stats");
    render();
    void refreshGit();
  }
}

/** @param {Frame} frame */
function response(frame) {
  const data = frame.data ?? {};

  if (frame.command === "get_messages") {
    const tab = active();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    transcript.replay(messages, !!tab?.running);
    // A reload should not have to wait for the next answer to know how fast
    // this model has been writing. The stored chat already says so.
    meter.history(messages);
    markDirty();
    render();
    return;
  }

  if (frame.command === "get_fork_messages") {
    forkMessages = Array.isArray(data.messages) ? data.messages : [];
    forkStamp += 1;
    markDirty();
    return;
  }

  if (frame.command === "fork") {
    if (data.cancelled === true) return;
    ask("get_messages");
    ask("get_state");
    ask("get_fork_messages");
    void loadSessions();
    toast("Forked: this chat carries on from that message", 5000);
    return;
  }

  if (frame.command === "get_commands") {
    state.commands = Array.isArray(data.commands) ? data.commands : [];
    return;
  }

  if (frame.command === "new_session" || frame.command === "clone") {
    if (data.cancelled === true) {
      toast("pi kept this chat where it was", 4000);
      return;
    }
    toast(frame.command === "clone" ? "Cloned: this chat is a copy of where it stood" : "A fresh session", 4000);
    transcript.clear();
    painted.clear();
    signatures.clear();
    el.transcript.replaceChildren();
    ask("get_state");
    ask("get_messages");
    ask("get_fork_messages");
    void loadSessions();
    return;
  }

  if (frame.command === "export_html") {
    const path = typeof data.path === "string" ? data.path : "";
    toast(path.length > 0 ? `Exported to ${path}` : "Exported", 6000);
    return;
  }

  if (frame.command === "clear_queue") {
    const waiter = queueWaiter;
    queueWaiter = null;
    if (waiter) waiter([...strings(data.steering), ...strings(data.followUp)]);
    return;
  }

  if (frame.command === "get_state") {
    const file = typeof data.sessionFile === "string" ? data.sessionFile : "";
    const tab = active();
    if (tab && file.length > 0) tab.sessionPath = file;

    const model = /** @type {PiModel | undefined} */ (data.model);
    state.model = model ? modelLabel(model) : "";
    state.modelKey = model ? modelKey(model) : "";

    const level = typeof data.thinkingLevel === "string" ? data.thinkingLevel : "";
    state.thinking = level;
    if (!state.thinkingDefault) state.thinkingDefault = level;

    // Pi counts what it is still holding. A page that reloaded mid-run never saw
    // those messages go in and would otherwise have no way of asking for them
    // back.
    const held = Number(data.pendingMessageCount);
    state.queued = Number.isFinite(held) ? held : 0;

    renderPickers();
    renderFooter();
    renderQueue();
    return;
  }

  if (frame.command === "get_available_models") {
    state.models = Array.isArray(data.models) ? /** @type {PiModel[]} */ (data.models) : [];
    renderPickers();
    return;
  }

  if (frame.command === "get_available_thinking_levels") {
    state.thinkingLevels = Array.isArray(data.levels) ? data.levels.map((level) => String(level)) : [];
    renderPickers();
    return;
  }

  if (frame.command === "get_session_stats") {
    const usage = /** @type {{tokens?: number | null, contextWindow?: number}} */ (data.contextUsage ?? {});
    // Straight after a compaction Pi has no count to give yet. The number from
    // before it would be the wrong kind of wrong, so the ring goes quiet until
    // an answer arrives that knows.
    const used = usage.tokens === null || usage.tokens === undefined ? 0 : Number(usage.tokens);
    state.context = { used, size: Number(usage.contextWindow ?? 0) };
    renderFooter();
    return;
  }

  if (frame.success === false) toast(frame.errorMessage ?? `${frame.command} failed`);
}

/** @param {TabInfo} tab */
function replaceTab(tab) {
  const index = state.tabs.findIndex((item) => item.id === tab.id);
  if (index >= 0) state.tabs[index] = tab;
  else state.tabs.unshift(tab);
  renderSidebar();
}

async function closeTab() {
  if (!state.active) return;
  const id = state.active;

  // The ✕ sits close enough to the other buttons that it is clicked by
  // accident, and on a chat that is working it is not a close but an end.
  if (active()?.running === true) {
    const yes = await askUser({
      title: "Stop this chat?",
      body: "pi is still working here. Closing the tab ends the run, and the answer will not arrive.",
      confirm: "Stop and close",
    });
    if (!yes) return;
  }
  await closeTabById(id);
}

/**
 * End one chat by id; only the one on screen gives up the pipe this page is reading.
 *
 * @param {string} id
 */
async function closeTabById(id) {
  await request(`/api/tab?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  state.tabs = state.tabs.filter((tab) => tab.id !== id);
  // The server ends the terminals that were opened for a chat with the chat, so
  // this page forgets them at the same moment rather than showing shells that
  // are already gone.
  for (const shell of state.shells.filter((item) => item.tab === id)) dropShell(shell.id);
  if (state.active !== id) {
    renderSidebar();
    return;
  }
  state.active = null;
  stream?.close();
  stream = null;
  renderSidebar();
  const next = state.tabs[0];
  if (next) return openTab(next.id);

  showEmptyState();
  await loadSessions();
}

/**
 * Run a `/command` this page answers itself; false leaves the line in the field to be fixed.
 *
 * @param {{name: string, run: string, argument: string}} route
 * @returns {Promise<boolean>}
 */
async function runCommand(route) {
  if (route.run === "") {
    toast(`/${route.name} opens a screen of pi's own, which this page cannot show`, 5000);
    return false;
  }

  const tab = active();
  const busy = tab?.running === true;

  switch (route.run) {
    case "new_session":
    case "clone": {
      if (busy) return busyNote(route.name);
      if (route.argument.length > 0) toast(`/${route.name} takes no argument`);
      void sendCommand({ type: route.run });
      return true;
    }

    case "compact": {
      void sendCommand(
        route.argument.length > 0 ? { type: "compact", customInstructions: route.argument } : { type: "compact" },
      );
      return true;
    }

    case "set_session_name": {
      if (route.argument.length === 0) return needsNote(route.name, "a name");
      void sendCommand({ type: "set_session_name", name: route.argument });
      return true;
    }

    case "export_html": {
      void sendCommand(
        route.argument.length > 0 ? { type: "export_html", outputPath: route.argument } : { type: "export_html" },
      );
      return true;
    }

    case "model": {
      const model = modelNamed(route.argument);
      if (model === null) {
        el.model.focus();
        if (route.argument.length > 0) toast(`no model here is called ${route.argument}`, 5000);
        return route.argument.length === 0;
      }
      el.model.value = modelKey(model);
      await pickModel();
      return true;
    }

    case "thinking": {
      if (route.argument.length === 0) {
        el.thinking.focus();
        return true;
      }
      const level = route.argument.toLowerCase();
      if (!state.thinkingLevels.includes(level)) {
        toast(`pi offers ${state.thinkingLevels.join(", ")}`, 5000);
        return false;
      }
      void sendCommand({ type: "set_thinking_level", level });
      return true;
    }

    case "copy": {
      const answer = lastAnswer();
      if (answer.length === 0) return needsNote(route.name, "an answer to copy");
      if (await toClipboard(answer)) toast("Copied!", 1200);
      return true;
    }

    case "session": {
      const { used, size } = state.context;
      toast(size > 0 ? `${tokens(used)} of ${tokens(size)} in context` : "pi has not counted this context yet", 5000);
      ask("get_session_stats");
      return true;
    }

    case "resume": {
      el.filter.focus();
      return true;
    }

    case "fork": {
      toast("the fork mark sits under the message a chat should start over from", 5000);
      return false;
    }

    case "reload": {
      if (busy) return busyNote(route.name);
      if (!tab) return false;
      const fresh = await createTab(tab.sessionPath ? { cwd: tab.cwd, session: tab.sessionPath } : { cwd: tab.cwd });
      if (fresh.length === 0) return false;
      await closeTabById(tab.id);
      toast("Reopened: pi reads its extensions, skills, prompts and files again", 5000);
      return true;
    }

    case "quit": {
      await closeTab();
      return true;
    }

    default:
      return false;
  }
}

/** @param {string} name */
function busyNote(name) {
  toast(`/${name} would end the answer pi is writing. Stop it first.`, 5000);
  return false;
}

/**
 * @param {string} name
 * @param {string} what
 */
function needsNote(name, what) {
  toast(`/${name} needs ${what}`, 4000);
  return false;
}

/**
 * The model a `/model` argument names, by `provider/id`, by id, or by the one name a list holds.
 *
 * @param {string} argument
 * @returns {PiModel | null}
 */

function modelNamed(argument) {
  if (argument.length === 0) return null;
  const needle = argument.toLowerCase();
  const direct = state.models.find((model) => modelKey(model).toLowerCase() === needle);
  if (direct) return direct;
  const byId = state.models.filter(
    (model) => model.id.toLowerCase() === needle || modelLabel(model).toLowerCase() === needle,
  );
  return byId.length === 1 ? byId[0] : null;
}

/** The text of the last answer this chat has on screen. */
function lastAnswer() {
  const blocks = transcript.blocks;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const text = blocks[index].kind === "text" ? (blocks[index].text ?? "") : "";
    if (text.trim().length > 0) return text;
  }
  return "";
}

// ----------------------------------------------------------------- sending

async function send() {
  const text = String(el.input.value);
  if (text.trim().length === 0 && attachments.length === 0) return;

  const call = attachments.length === 0 ? parseSlash(text) : null;
  const route = call === null ? null : slashRun(call, state.commands);
  if (route !== null && route.run !== "pi") {
    if (await runCommand(route)) {
      el.input.value = "";
      grow();
      hidePalette();
    }
    return;
  }

  // Typing into a page with no tab is a wish to start a chat, not a mistake.
  if (!state.active) await createTab({});
  if (!state.active) return;

  const running = active()?.running === true;
  const type = running ? (state.ui.send_mode === "queue" ? "follow_up" : "steer") : "prompt";

  /** @type {Record<string, unknown>} */
  const command = { type, message: text };
  if (attachments.length > 0) {
    command.images = attachments.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
  }

  const tabId = state.active;
  el.input.value = "";
  grow();
  clearAttachments();
  hidePalette();
  hold(tabId, text);

  try {
    await postJSON(`/api/cmd?id=${encodeURIComponent(tabId)}`, command);
  } catch (error) {
    release(tabId, text);
    el.input.value = el.input.value.length === 0 ? text : el.input.value;
    grow();
    toast(error instanceof Error ? error.message : "send failed");
  }
}

/** @type {Map<string, {text: string}[]>} */
const pending = new Map();

/**
 * A message Pi has not acknowledged yet stays visible above the composer, so
 * that the second between sending one and `queue_update` naming it is not a
 * moment where the page looks like it dropped the thought.
 *
 * @param {string} tabId
 * @param {string} text
 */
function hold(tabId, text) {
  const items = pending.get(tabId) ?? [];
  items.push({ text });
  pending.set(tabId, items);
  renderQueue();
}

/**
 * @param {string} tabId
 * @param {string} text
 */
function release(tabId, text) {
  const items = pending.get(tabId) ?? [];
  const index = items.findIndex((item) => item.text === text);
  if (index >= 0) items.splice(index, 1);
  if (items.length === 0) pending.delete(tabId);
  renderQueue();
}

/**
 * What Pi says it is holding, per chat. Pi pushes this itself with every
 * `queue_update`, so a row here is a message that really is waiting rather than
 * one this page merely hopes is waiting.
 *
 * @type {Map<string, {steering: string[], followUp: string[]}>}
 */
const heldQueues = new Map();

/** Which of Pi's two queues the chosen mode fills. */
function steeringCommand() {
  return state.ui.send_mode === "queue" ? "set_follow_up_mode" : "set_steering_mode";
}

/** The one word the strip uses: a reader chose a mode, and both halves of the
 * page have to say the same thing about what is waiting. */
function queueWord() {
  // Nothing is being steered while pi sits idle. A message sent to a chat that
  // is not working is simply the next thing it will do, whichever mode was
  // picked, and calling it steering would promise a turn that is not running.
  if (!transcript.running) return "on its way";
  return state.ui.send_mode === "queue" ? "queued" : "steering";
}

function renderQueue() {
  const tabId = state.active ?? "";
  const word = queueWord();
  const held = heldQueues.get(tabId);
  const texts = held ? [...held.steering, ...held.followUp] : [];
  const known = new Set(texts.map((text) => text.trim()));

  // What this page sent that Pi has not acknowledged yet, then what Pi holds.
  const rows = (pending.get(tabId) ?? [])
    .filter((item) => !known.has(item.text.trim()))
    .map((item) => item.text)
    .concat(texts);

  // A page that arrived in the middle of a run never saw the messages go in and
  // is only told how many there are.
  const blind = state.queued - (held ? texts.length : 0);
  if (blind > 0) rows.push(`${blind} from before this page`);

  el.queue.replaceChildren();
  for (const text of rows) {
    const row = element("div", "queued");
    row.append(span(word, "tag"), span(truncate(firstLine(text), 140), "text"));
    el.queue.append(row);
  }

  el.queue.hidden = rows.length === 0;
  if (rows.length > 0) el.queue.append(button("back to input", () => void pullQueue()));
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function strings(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/**
 * The one `clear_queue` this page is waiting an answer for. Pi's replies come
 * back on the event stream, not as the answer to the request that asked, so the
 * text has to be caught where the frames arrive.
 *
 * @type {((texts: string[] | null) => void) | null}
 */
let queueWaiter = null;

/**
 * Hand the queued messages back to the editor, the way Esc does in the terminal.
 *
 * Pi holds the queue, so it is asked to empty it and what it hands back goes in
 * the box. An answer that says nothing was queued is taken at its word: those
 * messages are already in the chat and putting them back would send them twice.
 * Only when no answer comes at all does the page fall back on the copies it was
 * holding, which is what a reader would otherwise have lost.
 */
async function pullQueue() {
  const tabId = state.active;
  if (!tabId) return;

  const items = pending.get(tabId) ?? [];
  pending.delete(tabId);
  renderQueue();

  heldQueues.set(tabId, { steering: [], followUp: [] });
  state.queued = 0;

  const cleared = await new Promise((resolve) => {
    let settled = false;
    /** @param {string[] | null} texts */
    const done = (texts) => {
      if (settled) return;
      settled = true;
      queueWaiter = null;
      resolve(texts);
    };
    queueWaiter = done;
    void sendCommand({ type: "clear_queue" });
    setTimeout(() => done(null), 2000);
  });

  const texts = cleared ?? items.map((item) => item.text);
  if (texts.length > 0) el.input.value = [el.input.value, ...texts].filter((line) => line).join("\n\n");
  grow();
  el.input.focus();
  renderQueue();
}

/**
 * Once Pi puts a message in the transcript it is no longer pending, and a run
 * that settled took everything with it.
 *
 * @param {Frame} frame
 */
function retirePending(frame) {
  const tabId = state.active;
  if (!tabId) return;

  if (frame.type === "agent_settled") {
    state.queued = 0;
    heldQueues.set(tabId, { steering: [], followUp: [] });
    pending.delete(tabId);
    renderQueue();
    return;
  }

  const message = /** @type {{role?: string, content?: unknown}} */ (frame.message ?? null);
  if (message?.role !== "user") return;

  const text = flatten(message.content).trim();
  const items = pending.get(tabId);
  const index = items ? items.findIndex((item) => item.text.trim() === text) : -1;
  if (index >= 0) {
    items?.splice(index, 1);
    if (items && items.length === 0) pending.delete(tabId);
  }

  // Pi only says how many messages it holds when it is asked, and a message
  // that has just landed in the chat came out of that number. So the number is
  // asked for again rather than counted down here: the messages a run is now
  // eating may have been queued by a page that is long gone, and this one has
  // no copy of them to subtract.
  if (state.queued > 0) ask("get_state");
  renderQueue();
}

function interrupt() {
  ask("abort");
}

/** @param {ClipboardEvent} event */
function onPaste(event) {
  const items = event.clipboardData?.items;
  if (!items) return;

  /** @type {File[]} */
  const files = [];
  for (const item of items) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) return;

  event.preventDefault();
  attachFiles(files);
}

/**
 * Pictures go to pi as base64, so a picture is what can be attached. The rest
 * is said out loud rather than dropped on the floor: a file that was dragged
 * with intent and vanished is the worst kind of quiet.
 *
 * @param {File[]} files
 */
function attachFiles(files) {
  let skipped = 0;
  let empty = 0;
  for (const file of files) {
    const kind = file.type.length > 0 ? file.type : guessType(file.name);
    if (!kind.startsWith("image/")) {
      skipped += 1;
      continue;
    }

    // A drag from outside a virtual machine often arrives as a name with no
    // bytes behind it. The chip would then sit there with a picture that never
    // loads, so it is refused where it failed instead of later.
    if (file.size === 0) {
      empty += 1;
      continue;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      if (comma < 0 || url.length - comma - 1 === 0) {
        attachEmpty += 1;
        renderAttachments();
        return;
      }
      attachments.push({ type: "image", mimeType: kind, data: url.slice(comma + 1) });
      renderAttachments();
    };
    reader.onerror = () => {
      attachEmpty += 1;
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }

  attachSkipped = skipped;
  attachEmpty += empty;
  renderAttachments();
  el.input.focus();
}

/** A dropped file often arrives without a type; the name is all there is. */
const types = /** @type {Record<string, string>} */ ({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
});

/** @param {string} name */
function guessType(name) {
  const at = name.lastIndexOf(".");
  return at < 0 ? "" : (types[name.slice(at + 1).toLowerCase()] ?? "");
}

/** @param {DragEvent} event */
function onDragOver(event) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  el.composer.dataset.drop = "on";
}

/** @param {DragEvent} event */
function onDragLeave(event) {
  if (event.relatedTarget instanceof Node && el.composer.contains(event.relatedTarget)) return;
  delete el.composer.dataset.drop;
}

/** @param {DragEvent} event */
function onDrop(event) {
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  event.preventDefault();
  delete el.composer.dataset.drop;
  attachFiles([...files]);
}

function clearAttachments() {
  attachments.length = 0;
  attachSkipped = 0;
  attachEmpty = 0;
  renderAttachments();
}

let attachSkipped = 0;
let attachEmpty = 0;

function renderAttachments() {
  el.attachments.replaceChildren(
    ...(attachSkipped > 0 ? [span(`${attachSkipped} not a picture — pi takes pictures`, "attach-note")] : []),
    ...(attachEmpty > 0
      ? [span(`${attachEmpty} arrived without its bytes — pick the file instead of dragging`, "attach-note")]
      : []),
    ...attachments.map((image, index) => {
      const chip = element("span", "attachment");
      const label = span("image");
      const thumb = document.createElement("img");
      thumb.src = imageDataUrl(image);
      thumb.alt = "attached picture";
      thumb.onerror = () => {
        chip.classList.add("broken");
        label.textContent = "unreadable picture";
      };
      chip.append(thumb, label);

      const drop = button("×", () => {
        attachments.splice(index, 1);
        renderAttachments();
      });
      chip.append(drop);
      return chip;
    }),
  );
  // The note about what did not make it belongs to the row, so the row stays
  // visible while there is something to read even though nothing attached.
  el.attachments.hidden = attachments.length === 0 && attachSkipped === 0 && attachEmpty === 0;
}

// ----------------------------------------------------------------- palette

function syncPalette() {
  const parsed = parseCommands(String(el.input.value));
  if (!parsed) return hidePalette();

  const matches = filterCommands(knownCommands(state.commands), parsed.query);
  if (matches.length === 0) return hidePalette();

  paletteIndex = Math.min(paletteIndex, matches.length - 1);
  el.palette.replaceChildren(
    ...matches.map((/** @type {import("./commands.js").Known} */ command, /** @type {number} */ index) => {
      const row = element("div", `palette-item${index === paletteIndex ? " active" : ""}`);
      row.append(
        span(`/${command.name}`, "cmd"),
        span(command.description ?? ""),
        span(
          command.run === "" ? "in pi's terminal" : (command.argumentHint ?? ""),
          command.run === "" ? "elsewhere" : "",
        ),
      );
      row.onclick = () => {
        paletteIndex = index;
        acceptPalette();
      };
      return row;
    }),
  );
  el.palette.hidden = false;
}

/**
 * @param {number} step
 * @param {Event} event
 */
function stepPalette(step, event) {
  event.preventDefault();
  const count = el.palette.children.length;
  if (count === 0) return;
  paletteIndex = (paletteIndex + step + count) % count;
  syncPalette();
}

/** @param {Event} [event] */
function acceptPalette(event) {
  event?.preventDefault();

  const parsed = parseCommands(String(el.input.value));
  const matches = filterCommands(knownCommands(state.commands), parsed?.query ?? "");
  const chosen = matches[paletteIndex];
  if (!chosen) return hidePalette();

  el.input.value = `/${chosen.name} `;
  paletteIndex = 0;
  hidePalette();
  el.input.focus();
}

/** @param {Event} [event] */
function hidePalette(event) {
  event?.preventDefault();
  el.palette.hidden = true;
  paletteIndex = 0;
}

// --------------------------------------------------------------- rendering

function markDirty() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    renderStream();
  });
}

/**
 * What an answer repaints. The chat list is deliberately not in here: it would
 * be rebuilt on every token, and a row that is replaced between the press and
 * the release never sees the click, which is how switching chats mid-answer
 * stops working.
 */
function renderStream() {
  renderTranscript();
  renderQueue();
  renderFooter();
}

function render() {
  renderSidebar();
  renderStream();
}

/**
 * The sidebar.
 *
 * Open chats split into the two states you act on — pi is still working, or it
 * is done. Past sessions split by the folder they happened in, because that is
 * how one gets found again.
 */
function renderSidebar() {
  if (rowMenu && !rowMenu.anchor.isConnected) closeMenuButton();
  markOpenChatRead();
  const filter = String(el.filter.value).trim().toLowerCase();
  const hits = rank(filter, state.tabs, (tab) => [labelOf(tab), tab.cwd]);
  const visible = hits.map((hit) => hit.item);
  const marks = new Map(hits.map((hit) => [hit.item.id, hit.ranges]));
  const row = (/** @type {TabInfo} */ tab) => tabRow(tab, marks.get(tab.id) ?? []);

  const { working, settled } = splitTabs(visible);

  /** @type {HTMLElement[]} */
  const rows = [groupHeader("Working", working.length, groups.Working)];
  if (groups.Working) rows.push(...working.map(row));
  rows.push(groupHeader("Settled", settled.length, groups.Settled));
  if (groups.Settled) rows.push(...settled.map(row));
  if (visible.length === 0) rows.push(element("div", "empty", "no open chats"));

  if (!pressingTabs) repaint(el.tabs, rows, tabsMemo);
  renderSessions(filter);
}

/** @type {{paint: string}} */ const tabsMemo = { paint: "" };

/** A chat list rebuilt under a held pointer loses the press, so it waits for the release. */
let pressingTabs = false;

/** @type {ReturnType<typeof setTimeout> | undefined} */
let holdTimer;

/** Let the chat list repaint again once a press is over, and show what it missed. */
function releaseTabs() {
  if (!pressingTabs) return;
  pressingTabs = false;
  clearTimeout(holdTimer);
  renderSidebar();
}

/** @type {{paint: string}} */ const sessionsMemo = { paint: "" };

/**
 * Replace a list's rows only when the list would look different. Both lists are
 * rebuilt wholesale, and a row swapped out between the press and the release
 * never sees the click — which is what makes a chat impossible to switch to
 * while something repaints the sidebar.
 *
 * @param {HTMLElement} box
 * @param {HTMLElement[]} rows
 * @param {{paint: string}} memo
 * @returns {boolean} whether the box changed
 */
function repaint(box, rows, memo) {
  if (rowMenu) return false;

  const draft = element("div");
  draft.append(...rows);
  const next = draft.innerHTML;
  if (next === memo.paint) return false;

  memo.paint = next;
  box.replaceChildren(...rows);
  return true;
}

/**
 * Past sessions, newest folder first, a handful per folder until someone asks
 * for the rest. While something is typed they are ranked by the match instead,
 * and every hit is shown: a list cut to five stops being a search result.
 *
 * @param {string} filter
 */
function renderSessions(filter) {
  const kept = el.sessions.scrollTop;
  paintProjectFilter();

  const inProject = state.sessions.filter((entry) => sessionProject === "all" || bucketOf(entry) === sessionProject);
  const hits = rank(filter, inProject, (entry) => [sessionTitle(entry), entry.cwd ?? ""]);

  /** @type {HTMLElement[]} */
  const rows = [];
  for (const [bucket, list] of folders(hits)) {
    const shown = filter.length > 0 || expanded.has(bucket) ? list : list.slice(0, perProject);
    rows.push(groupLabel(projectLabel(bucket)));
    rows.push(...shown.map((hit) => sessionRow(hit.item, hit.ranges)));
    if (shown.length < list.length) rows.push(moreButton(bucket, list.length - shown.length));
  }

  if (rows.length === 0) rows.push(element("div", "empty", "no sessions here"));

  if (repaint(el.sessions, rows, sessionsMemo)) el.sessions.scrollTop = kept;
}

/**
 * What a session is called in the list: its first line, else its pi-given
 * name, else the bare id.
 *
 * @param {SessionEntry} entry
 */
function sessionTitle(entry) {
  return entry.first_text ? firstLine(entry.first_text) : (entry.name ?? entry.id);
}

/**
 * @param {SessionEntry} entry
 * @param {[number, number][]} ranges
 */
function sessionRow(entry, ranges = []) {
  const already = state.tabs.find((tab) => tab.sessionPath === entry.path);
  const row = element("div", `session${already ? " open" : ""}${entry.running ? " running" : ""}`);
  const title = span(sessionTitle(entry), "session-title");
  if (ranges.length > 0) {
    title.replaceChildren();
    title.append(highlight(sessionTitle(entry), ranges, "mark"));
  }
  row.append(title, span(`${relativeTime(entry.updated, Date.now())} · ${entry.messages} msgs`, "session-meta"));
  row.onclick = () => void (already ? openTab(already.id) : createTab({ session: entry.path }));
  row.append(menuButton(() => [{ label: "Copy path", run: () => void copyPath(entry.cwd ?? "") }]));
  return row;
}

/**
 * Which pile a session belongs to. Scratch chats each got their own throw-away
 * directory, but nobody reads fifty directory ids; they are one group.
 *
 * @param {SessionEntry} entry
 */
function bucketOf(entry) {
  const cwd = entry.cwd ?? "";
  const at = cwd.indexOf("/scratch/");
  return at >= 0 ? `${cwd.slice(0, at)}/scratch` : cwd;
}

/**
 * @param {string} bucket
 * @param {number} rest
 */
function moreButton(bucket, rest) {
  const more = element("button", "more", `+${rest} more`);
  more.setAttribute("type", "button");
  more.onclick = () => {
    expanded.add(bucket);
    renderSidebar();
  };
  return more;
}

let projectKey = "";

/** The folder dropdown only changes when the folders do, so it keeps focus. */
function paintProjectFilter() {
  const projects = folders(state.sessions.map((entry) => ({ item: entry, ranges: [] })))
    .map(([bucket]) => bucket)
    .sort((a, b) =>
      a.length === 0
        ? 1
        : b.length === 0
          ? -1
          : projectLabel(a).localeCompare(projectLabel(b), undefined, { sensitivity: "base" }),
    );
  const key = projects.join("\n");
  if (sessionProject !== "all" && !projects.includes(sessionProject)) sessionProject = "all";

  if (key !== projectKey) {
    projectKey = key;
    el.sessionProject.replaceChildren(
      new Option("all projects", "all"),
      ...projects.map((cwd) => new Option(projectLabel(cwd), cwd)),
    );
  }

  el.sessionProject.value = sessionProject;
  el.sessionProject.hidden = projects.length < 2;
}

/**
 * The sessions grouped by the folder they happened in. The groups come in the
 * order of the list they were built from, which is newest chat first, so the
 * folder you were just in sits on top; `no folder` goes to the bottom. The
 * dropdown that picks one of these is sorted a-z instead, because finding one
 * in a list is not the same job as finding the most recent one.
 *
 * @param {{item: SessionEntry, ranges: [number, number][]}[]} hits
 * @returns {[string, {item: SessionEntry, ranges: [number, number][]}[]][]}
 */
function folders(hits) {
  const groups = [...groupBy(hits, (hit) => bucketOf(hit.item))];
  return groups.sort(([a], [b]) => (a.length === 0 ? 1 : b.length === 0 ? -1 : 0));
}

/**
 * A project's name in the list and in the dropdown. Two folders with the same
 * last segment are told apart by the one above it.
 *
 * @param {string} bucket
 */
function projectLabel(bucket) {
  if (bucket.length === 0) return "no folder";
  const name = basename(bucket);
  const clash = state.sessions.some((other) => {
    const cwd = bucketOf(other);
    return cwd !== bucket && cwd.length > 0 && basename(cwd) === name;
  });
  return clash ? `${name} · ${basename(dirOf(bucket))}` : name;
}

/**
 * @param {TabInfo} tab
 * @returns {HTMLElement}
 */
/**
 * One chat, three lines: where it runs and what pi is doing with it, the title,
 * and the branch or folder it belongs to.
 *
 * @param {TabInfo} tab
 * @param {[number, number][]} [ranges]
 */
function tabRow(tab, ranges = []) {
  const unread = isUnread(tab, seen, state.active);
  const row = element("button", `tab${tab.id === state.active ? " active" : ""}${unread ? " unread" : ""}`);
  row.dataset.tab = tab.id;

  const top = element("div", "tab-top");
  top.append(span(badgeOf(tab), "badge"), span(isProjectCwd(tab.cwd) ? basename(tab.cwd) : "chat", "tab-proj"));
  const status = element("span", "tab-status");
  if (tab.running) {
    const since = tab.runStartedMs ?? tab.createdMs;
    status.append(spinner(), span(`working ${ago(Date.now() - since)}`, "live"));
  } else if (unread) {
    status.append(span("done", "done"));
  } else if (tab.lastOutputMs > 0) {
    status.append(span(ago(Date.now() - tab.lastOutputMs), "idle"));
  }
  top.append(status);

  const title = span(labelOf(tab), "tab-title");
  if (ranges.length > 0) {
    title.replaceChildren();
    title.append(highlight(labelOf(tab), ranges, "mark"));
  }
  row.append(top, title, tabFoot(tab));
  row.onclick = () => void openTab(tab.id);
  row.append(
    menuButton(() => [
      { label: "Copy path", run: () => void copyPath(tab.cwd) },
      {
        label: "Archive into sessions",
        danger: true,
        run: () => {
          state.active = tab.id;
          void closeTab();
        },
      },
    ]),
  );
  return row;
}

/**
 * The ⋯ button at the right edge of a sidebar row, which is what opens a row's
 * actions now. Right-click used to do it, and closing a chat is too expensive a
 * mistake for a stray click: this has to be aimed at.
 *
 * @param {() => {label: string, danger?: boolean, run: () => void}[]} build
 */
/**
 * A button that hangs a list of actions under itself. The list is built when it
 * is opened, so what is offered can match what is true at that moment.
 *
 * @param {() => {label: string, run: () => void, danger?: boolean}[]} build
 * @param {string} [glyph]
 * @param {string} [cls]
 */
function menuButton(build, glyph = "⋯", cls = "row-menu") {
  const button = element("button", cls, glyph);
  button.setAttribute("type", "button");
  button.title = "Actions";
  button.onclick = (event) => {
    event.stopPropagation();
    if (rowMenu?.anchor === button) return closeMenuButton();
    // The open menu belongs to another row. Nothing else takes it down: the
    // record of it is about to be overwritten, and the node would keep hanging
    // on the page over the next one.
    closeMenu();
    const list = element("div", "row-actions");
    for (const action of build()) {
      const item = element("button", `row-action${action.danger ? " danger" : ""}`, action.label);
      item.setAttribute("type", "button");
      item.onclick = (event) => {
        event.stopPropagation();
        closeMenuButton();
        action.run();
      };
      list.append(item);
    }
    // Fixed to the viewport and hung off the body: the sidebar clips its own
    // overflow, and a menu that lives inside it lands wherever that box is
    // rather than under the dots it belongs to.
    document.body.append(list);
    const at = button.getBoundingClientRect();
    list.style.top = `${at.bottom + 2}px`;
    list.style.right = `${Math.max(0, window.innerWidth - at.right)}px`;
    if (window.innerHeight - at.bottom < list.offsetHeight + 8) {
      list.style.top = `${Math.max(4, at.top - list.offsetHeight - 2)}px`;
    }
    button.parentElement?.classList.add("menu-open");
    rowMenu = { anchor: button, list };
  };
  return button;
}

/** @type {{anchor: HTMLElement, list: HTMLElement} | null} */
let rowMenu = null;

/** Take the open row menu off the page. The lists around it are left alone. */
function closeMenu() {
  if (!rowMenu) return;
  rowMenu.list.remove();
  rowMenu.anchor.parentElement?.classList.remove("menu-open");
  rowMenu = null;
}

function closeMenuButton() {
  if (!rowMenu) return;
  closeMenu();
  renderSidebar();
}

/** @type {((yes: boolean) => void) | null} */
let askResolve = null;

/**
 * A question with two buttons, asked before something destructive. Escape and
 * the scrim both answer no, because doing nothing is always allowed.
 *
 * @param {{title: string, body: string, confirm: string}} question
 * @returns {Promise<boolean>}
 */
function askUser(question) {
  return new Promise((resolve) => {
    askResolve = resolve;
    const row = element("div", "row-buttons");
    row.append(
      button("Cancel", () => answerAsk(false)),
      button(question.confirm, () => answerAsk(true)),
    );
    el.askModal.replaceChildren(card(question.title, span(question.body, "ask-body"), row));
    el.askModal.hidden = false;
    row.querySelector("button")?.focus();
  });
}

/** @param {boolean} yes */
function answerAsk(yes) {
  const resolve = askResolve;
  if (!resolve) return;
  askResolve = null;
  el.askModal.hidden = true;
  el.askModal.replaceChildren();
  resolve(yes);
}

/** @param {string} text */
async function copyPath(text) {
  if (text.length === 0) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(`copied ${text}`);
  } catch {
    toast("the browser would not hand over the clipboard");
  }
}

/**
 * @param {TabInfo} tab
 */
function tabFoot(tab) {
  const foot = element("div", "tab-foot");
  const branch = tab.id === state.active ? (status?.branch ?? "") : "";
  foot.append(span(branch.length > 0 ? branch : shortPath(tab.cwd), "path"));
  if (tab.id === state.active && state.model.length > 0) foot.append(span(shortModel(state.model), "model"));
  return foot;
}

/**
 * Two letters of the folder, so a stack of chats is scannable at a glance.
 *
 * @param {TabInfo} tab
 */
function badgeOf(tab) {
  return badge(tab.cwd, isProjectCwd(tab.cwd));
}

/**
 * Whether a tab sits in a real project or in a throwaway scratch folder. The
 * server's `project` flag only says how the tab was started; a resumed chat in
 * a project is still a project chat.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isProjectCwd(cwd) {
  return cwd.length > 0 && !cwd.includes("/scratch/");
}

/** @param {string} model */
function shortModel(model) {
  const at = model.lastIndexOf("/");
  return at >= 0 ? model.slice(at + 1) : model;
}

/**
 * @param {string} label
 * @param {number} count
 * @param {boolean} open
 */
function groupHeader(label, count, open) {
  const head = element("button", "group");
  head.setAttribute("type", "button");
  head.append(span(label, "group-name"), span(String(count), "group-count"), span(open ? "⌄" : "›", "caret"));
  head.onclick = () => {
    groups[label] = !groups[label];
    renderSidebar();
  };
  return head;
}

function renderTranscript() {
  const seen = new Set();
  const before = earlierWrites();
  // How a block is painted depends on it, so it belongs in what a block is remembered by.
  const thoughts = state.ui.show_thinking === true ? "" : "no-thoughts ";

  for (const block of transcript.blocks) {
    seen.add(block.id);
    const signature = `${thoughts}${forkStamp} ${JSON.stringify(block)}`;
    if (signatures.get(block.id) === signature) continue;

    let node = painted.get(block.id);
    if (!node) {
      node = element("div", `block ${block.kind}`);
      painted.set(block.id, node);
      el.transcript.append(node);
    }
    // A row under the pointer is left exactly as it stands. Rebuilding it takes
    // the line out of the document and back, and a press that spans that gets no
    // click at all: the reader who wants to read a thought while it is still
    // streaming could not open it. The next frame after the release catches up.
    if (node === pressed) continue;

    signatures.set(block.id, signature);
    paint(node, block, before.get(block.id) ?? null);
  }

  for (const [id, node] of painted) {
    if (seen.has(id)) continue;
    painted.delete(id);
    signatures.delete(id);
    node.remove();
  }

  paintEnded();
  if (state.follow) jumpToEnd();
}

/** @type {HTMLElement | null} */ let endedNote = null;
/** What the ended notice said the last time it was painted. */
let endedPaint = "";

/**
 * What the middle of the page says about a chat that is not quite itself: one
 * whose process ended, or one being read from a copy because the folder it was
 * written in is gone. Either would otherwise look like a page that failed to
 * load, so the reason stays on screen with the one way out of it.
 */
function paintEnded() {
  const tab = active();

  /** @type {{title: string, why: string, label: string, run: () => void} | null} */
  let said = null;
  if (tab?.copiedFrom) {
    said = {
      title: "The folder this chat was written in is gone",
      why: tab.goneFolder ?? "its folder",
      label: "create the folder and continue",
      run: () => void createTab({ cwd: tab.goneFolder ?? "", session: tab.copiedFrom ?? "", recreate: true }),
    };
  } else if (tab?.closed) {
    said = {
      title: "This chat ended",
      why: endings.get(tab.id) ?? "this chat is closed",
      label: "open it again",
      run: () => void createTab(tab.sessionPath ? { cwd: tab.cwd, session: tab.sessionPath } : { cwd: tab.cwd }),
    };
  }

  if (said === null) {
    endedNote?.remove();
    endedNote = null;
    endedPaint = "";
    return;
  }

  const stamp = `${said.title}\n${said.why}`;
  if (endedPaint === stamp && endedNote?.isConnected) return;

  endedPaint = stamp;
  const note = element("div", "chat-ended");
  note.append(
    element("p", "ended-title", said.title),
    element("p", "ended-why", said.why),
    button(said.label, said.run),
  );
  endedNote?.remove();
  el.transcript.append(note);
  endedNote = note;
}

/** How far the reading position sits above the newest block. */
function scrollGap() {
  return el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight;
}

/**
 * Scrolling up is a decision: stop pinning the newest output and offer the way
 * back. Scrolling to the bottom is the opposite decision, so it re-arms it.
 */
function watchScroll() {
  state.follow = scrollGap() < 60;
  el.jump.hidden = state.follow;
}

function jumpToEnd() {
  el.transcript.scrollTop = el.transcript.scrollHeight;
  state.follow = true;
  el.jump.hidden = true;
}

/**
 * What an earlier write left at the same path, per write block. A rewrite of a
 * file the transcript already wrote can then be shown as a diff instead of a
 * wall of text.
 *
 * @returns {Map<number, string | null>}
 */
function earlierWrites() {
  /** @type {Map<string, string>} */
  const latest = new Map();
  /** @type {Map<number, string | null>} */
  const before = new Map();

  for (const block of transcript.blocks) {
    if (block.kind !== "tool" || block.toolName !== "write") continue;
    const path = String(block.args?.path ?? "");
    if (path.length === 0) continue;
    before.set(block.id, latest.get(path) ?? null);
    latest.set(path, String(block.args?.content ?? ""));
  }
  return before;
}

/**
 * @param {HTMLElement} node
 * @param {Block} block
 * @param {string | null} [before]
 */
function paint(node, block, before = null) {
  const kept = scrollOf(node);

  node.replaceChildren();

  switch (block.kind) {
    case "user": {
      node.append(span("you", "who"), span(block.text ?? "", "body"));
      for (const image of /** @type {import("./transcript.js").Image[]} */ (block.images ?? [])) {
        node.append(shot(image));
      }
      node.append(messageActions(block, block.text ?? ""));
      return;
    }

    case "thinking": {
      const text = block.text ?? "";
      const { fold, summary, body } = foldFor(block, false, block.lastWord === true);
      if (block.lastWord) node.classList.add("last-word");
      summary.append(span(block.done ? "thoughts" : "thinking", "name"));
      if (state.ui.show_thinking === true) {
        summary.append(span(truncate(block.done ? firstLine(text) : lastLine(text), 90), "title"));
      }
      if (block.lastWord) summary.append(span("nothing after", "state"));
      body.append(markdownBox(text, "thinking-body"), messageActions(block, text));
      node.append(fold);
      break;
    }

    case "text": {
      node.append(markdownBox(block.text ?? "", "body"));
      const foot = element("div", "foot");
      if (block.usage) foot.append(span(usageLine(block.usage)));
      if (block.stopReason === "aborted") foot.append(span("aborted", "warn"));
      if (block.error) foot.append(span(block.error, "warn"));
      if ((block.usage || block.error) && foot.childNodes.length > 0) node.append(foot);
      node.append(messageActions(block, block.text ?? ""));
      return;
    }

    case "tool": {
      const shown = block.result ?? block.progress;
      const pictures = /** @type {import("./transcript.js").Image[]} */ (block.images ?? []);
      const view = toolView(
        block.toolName ?? "tool",
        block.args ?? null,
        shown === null || shown === undefined ? "" : flatten(shown),
        block.details,
        before,
        pictures.length,
      );

      const { fold, summary, body } = foldFor(block, false);
      if (block.isError) fold.classList.add("error");
      const hint = span("", "hint");
      for (const part of hintParts(view.hint)) hint.append(span(part.text, part.kind));
      const state = span(block.done ? (block.isError ? "failed" : elapsed(block)) : "", "state");
      if (!block.done) state.append(liveClock(block));
      summary.append(span(block.toolName ?? "tool", "name"), span(block.title ?? "", "title"), hint, state);
      if (block.isError) summary.prepend(span("⚠", "flag"));
      if (!block.done) summary.prepend(spinner());

      if (view.command.length > 0) body.append(commandRow("command", view.command));
      if (view.input.length > 0) body.append(argumentRow(view.input));
      if (view.rows !== null && view.rows.length > 0) {
        body.append(diffRows(view.rows));
      } else if (view.text.length > 0) {
        const out = boxed(view.text, "body");
        if (!block.done) out.classList.add("live");
        body.append(out);
      }
      if (view.chips.length > 0) body.append(chipRow(view.chips));
      if (body.childNodes.length === 0) body.append(span(block.done ? "no output" : "nothing back yet", "muted"));
      const told = view.command.length > 0 ? view.command : String(block.args?.command ?? "");
      body.append(messageActions(block, told.length > 0 ? told : view.text));
      node.append(fold);

      // A picture goes outside the fold. Reading it is usually why the file was
      // opened, and a line about it is no substitute with the fold shut.
      for (const image of pictures) node.append(shot(image));
      break;
    }

    case "bash": {
      node.append(
        span("shell", "who"),
        element("pre", "pre", block.text ?? ""),
        messageActions(block, block.text ?? ""),
      );
      return;
    }

    case "compaction": {
      const { fold, summary, body } = foldFor(block, false);
      summary.append(span(block.text ?? "compacted", "name"));
      if (block.summary) body.append(boxed(block.summary, "body"));
      body.append(messageActions(block, block.summary ?? block.text ?? ""));
      node.append(fold);
      break;
    }

    case "status": {
      node.append(span(block.text ?? "", "body muted"));
      return;
    }

    default: {
      node.append(span(block.text ?? "", "body error-text"));
    }
  }

  for (const empty of node.querySelectorAll(".fold-body:empty")) empty.remove();
  restoreScroll(node, kept);
}

/**
 * @param {Block} block
 * @param {string} text
 */
function messageActions(block, text) {
  const row = element("div", "msg-actions");

  if (text.trim().length > 0) {
    const copy = iconButton("copy", "copy message", () => void copyMessage(text));
    copy.title = "Copy this to the clipboard";
    row.append(copy);
  }

  const prompt = turnPrompt(block);
  const entryId = prompt === null ? "" : entryOf(prompt);
  if (entryId.length > 0) {
    const fork = iconButton("fork", "fork here", () => void forkAt(entryId));
    fork.title = `Start this chat over from: ${truncate(prompt?.text ?? "", 70)}`;
    row.append(fork);
  }

  return row;
}

/** @param {string} text */
async function copyMessage(text) {
  if (await toClipboard(text)) toast("Copied!", 1200);
}

/**
 * @param {Block} block
 * @returns {Block | null}
 */
function turnPrompt(block) {
  const all = transcript.blocks;
  for (let index = all.indexOf(block); index >= 0; index -= 1) {
    if (all[index]?.kind === "user") return all[index] ?? null;
  }
  return null;
}

/** @param {Block} block */
function entryOf(block) {
  const text = block.text ?? "";
  for (let index = forkMessages.length - 1; index >= 0; index -= 1) {
    if (forkMessages[index]?.text === text) return forkMessages[index]?.entryId ?? "";
  }
  return "";
}

/** @param {string} entryId */
async function forkAt(entryId) {
  await sendCommand({ type: "fork", entryId });
}

/**
 * A fold that keeps the state the reader picked. Nothing opens itself: a
 * transcript that expands on its own while pi works is noise, and the reader
 * who wants the detail clicks once and keeps it open.
 *
 * Repainting happens while a tool streams, and a fold that snaps shut mid-read
 * is unusable.
 *
 * The summary is a plain line in the flow of the chat; only what is open gets a
 * box, so a long transcript stays quiet until someone asks for the detail.
 *
 * @param {Block} block
 * @param {boolean} opened
 * @returns {{fold: HTMLDetailsElement, summary: HTMLElement, body: HTMLElement}}
 */
function foldFor(block, opened, open = false) {
  const fold = /** @type {HTMLDetailsElement} */ (document.createElement("details"));
  const summary = document.createElement("summary");
  const body = element("div", "fold-body");

  fold.open = open || (folds.get(block.id) ?? opened);
  fold.addEventListener("toggle", () => folds.set(block.id, fold.open));
  fold.append(summary, body);
  return { fold, summary, body };
}

/**
 * How long a finished tool ran. The tool's own number comes with its result
 * and is the one worth showing; the two stamps are the fallback, and they can
 * both be missing when a tab joined a run that was already going. A blink is
 * not worth a number.
 *
 * @param {Block} block
 */
function elapsed(block) {
  const measured =
    block.durationMs ??
    (block.doneAt !== undefined && block.startedAt !== undefined ? block.doneAt - block.startedAt : 0);
  return measured > 1500 ? duration(measured) : "";
}

/**
 * The count a waiting reader watches. It carries its own start so the one
 * second beat of the page can move it without rebuilding the row under a
 * pointer that might be clicking it.
 *
 * @param {Block} block
 */
function liveClock(block) {
  const from = block.startedAt ?? Date.now();
  const node = span(duration(Math.max(0, Date.now() - from)), "tick");
  node.dataset.tick = String(from);
  return node;
}

/**
 * Assistant prose is markdown. Tool output stays plain text: a log is not a
 * document and should keep its shape.
 *
 * @param {string} text
 * @param {string} className
 */
function markdownBox(text, className) {
  const box = element("div", `md ${className}`);
  box.append(markdownNode(parseMarkdown(text)));
  return box;
}

/**
 * An argument the summary line had to cut short, in full and in one piece.
 *
 * @param {string} label
 * @param {string} value
 */
function commandRow(label, value) {
  const box = element("div", "args");
  const row = element("div", "arg full");
  row.append(span(label, "k"), element("pre", "v", value));
  box.append(row);
  return box;
}

/**
 * The arguments a call was given, as far as the summary line had no room for
 * them.
 *
 * @param {import("./toolview.js").Chip[]} chips
 */
function argumentRow(chips) {
  const box = element("div", "args");
  for (const chip of chips) {
    const row = element("div", "arg");
    row.append(span(chip.label, "k"), span(chip.value, "v"));
    box.append(row);
  }
  return box;
}

/**
 * @param {string} text
 * @param {string} key stable key so the scroll position survives a repaint
 */
function boxed(text, key) {
  const box = element("pre", "pre", text);
  box.dataset.scroll = key;
  return box;
}

/**
 * A picture with the two things a picture in a log needs: a way to see it at
 * the size it was drawn at, and a cursor that says so.
 *
 * @param {import("./transcript.js").Image} image
 */
function shot(image) {
  const node = /** @type {HTMLButtonElement} */ (element("button", "shot"));
  node.type = "button";
  node.title = "See it full size";

  const thumb = document.createElement("img");
  thumb.className = "thumb";
  thumb.src = imageDataUrl(image);
  thumb.alt = "";

  const mark = element("span", "zoom");
  mark.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">' +
    '<circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.4 15.4 21 21" /><path d="M10.5 7.6v5.8M7.6 10.5h5.8" /></svg>';

  node.append(thumb, mark);
  node.onclick = () => showShot(thumb.src);
  return node;
}

/** @param {string} src */
function showShot(src) {
  el.lightboxImg.src = src;
  el.lightbox.hidden = false;
}

function hideShot() {
  el.lightbox.hidden = true;
  el.lightboxImg.removeAttribute("src");
}

/** @param {import("./toolview.js").Chip[]} chips */
function chipRow(chips) {
  const row = element("div", "chips");
  for (const chip of chips) {
    const node = element("span", "chip-meta");
    node.append(span(chip.label, "key"), span(chip.value, "value"));
    row.append(node);
  }
  return row;
}

/** @param {import("./diff.js").Row[]} rows */
function diffRows(rows) {
  const box = element("div", "tool-diff");
  box.dataset.scroll = "diff";
  for (const row of rows) {
    if (row.kind === "hunk" || row.kind === "meta") {
      box.append(element("div", "hunk-sep", row.text));
      continue;
    }
    const line = element("div", `row ${row.kind}`);
    line.append(
      span(row.old === null ? "" : String(row.old), "no"),
      span(row.new === null ? "" : String(row.new), "no"),
      span(row.text, "code"),
    );
    box.append(line);
  }
  return box;
}

/**
 * @param {HTMLElement} node
 * @returns {Map<string, number[]>}
 */
function scrollOf(node) {
  /** @type {Map<string, number[]>} */
  const saved = new Map();
  for (const found of node.querySelectorAll("[data-scroll]")) {
    const box = /** @type {HTMLElement} */ (found);
    saved.set(box.dataset.scroll ?? "", [box.scrollLeft, box.scrollTop]);
  }
  return saved;
}

/**
 * @param {HTMLElement} node
 * @param {Map<string, number[]>} saved
 */
function restoreScroll(node, saved) {
  for (const found of node.querySelectorAll("[data-scroll]")) {
    const box = /** @type {HTMLElement} */ (found);
    const place = saved.get(box.dataset.scroll ?? "");
    if (!place) continue;
    box.scrollLeft = place[0];
    box.scrollTop = place[1];
  }
}

let runTab = "";
let runSince = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let runTicker = null;

/**
 * Spins the composer indicator and counts how long this answer is taking.
 *
 * The count starts where the run started, which the server knows: switching to
 * a chat that has been working for three minutes has to read three minutes, not
 * one second since the click. The same chat asked again has moved that start, so
 * the count goes back to the top for it too.
 *
 * @param {import("./protocol.js").TabInfo | null} tab
 * @param {boolean} running
 */
function trackRun(tab, running) {
  const tabId = tab?.id ?? "";
  const started = Number(tab?.runStartedMs) || 0;
  if (running && (runTab !== tabId || (started > 0 && started !== runSince))) {
    runTab = tabId;
    runSince = started || Date.now();
  }
  if (!running) {
    // An answer just ended in this chat. If the reader is watching the panel,
    // what the turn changed should be in it without another click.
    const finished = tabId.length > 0 && runTab === tabId;
    runTab = "";
    runSince = 0;
    if (finished) {
      refreshPanel();
      refreshOpenDiff();
    }
  }

  if (running && !runTicker) {
    runTicker = setInterval(() => {
      renderFooter();
      for (const node of el.transcript.querySelectorAll("[data-tick]")) {
        node.textContent = duration(Math.max(0, Date.now() - Number(node.dataset.tick)));
      }
    }, 1000);
  }
  if (!running && runTicker) {
    clearInterval(runTicker);
    runTicker = null;
  }

  el.busy.hidden = !running;
  el.busyTime.textContent = runSince ? duration(Date.now() - runSince) : "";
}

/** When the answer that is streaming now began. */
let turnStartedAt = 0;

function renderFooter() {
  const tab = active();
  const reading = meter.reading();

  trackRun(tab, !!tab?.running);
  paintContext();

  const parts = [];
  if (meter.cost() > 0) parts.push(cost(meter.cost()));
  el.status.textContent = state.active ? (state.connected ? parts.join(" · ") : "disconnected") : "no chat open";

  // The pace of the last few answers, not of the last second: a run that is
  // only thinking, or a page that was reloaded mid-answer, has nothing honest
  // to say about the moment and plenty to say about the model.
  const pace = meter.pace();
  const speed = pace > 0 ? pace : reading.tokensPerSecond;
  el.rate.textContent = state.active && (speed > 0 || transcript.running) ? perSecond(speed) : "";
  el.rate.classList.toggle("live", transcript.running);
  el.abort.hidden = !tab?.running;
  el.send.disabled = state.active ? !state.connected : false;

  // The counters belong to a chat. A band that would hold nothing but a
  // hairline is better off gone, and a terminal never wears one at all.
  el.meterBar.hidden =
    terminalInView() !== "" ||
    (el.busy.hidden && el.context.hidden && parts.length === 0 && el.rate.textContent.length === 0);
}

/**
 * The ring is how much of the window this chat has eaten, straight from pi's
 * own count of what it would send next. A number from an earlier chat would be
 * worse than no number, so it is cleared whenever a different chat is opened.
 */
function paintContext() {
  const ring = contextRing(state.context.used, state.context.size);
  el.context.hidden = ring.percent === 0;
  el.context.dataset.tone = ring.tone;
  el.contextRing.style.setProperty("--used", String(ring.fraction));
  el.contextPct.textContent = `${ring.percent}%`;
  el.context.title = `context ${ring.label} · ${ring.percent}%`;
}

// ------------------------------------------------------------ model & thinking

/** @param {PiModel} model */
function modelKey(model) {
  return `${model.provider ?? ""}/${model.id}`;
}

/** @param {PiModel} model */
function modelLabel(model) {
  return model.name && model.name.length > 0 ? model.name : model.id;
}

function renderPickers() {
  const ready = state.connected && Boolean(state.active);

  /** @type {[string, string][]} */
  const idle = [["", state.active ? "loading\u2026" : "no chat"]];
  const models = state.models.map((model) => /** @type {[string, string]} */ ([modelKey(model), modelLabel(model)]));

  fill(el.model, models.length > 0 ? models : idle, state.modelKey, ready);

  const levels = state.thinkingLevels.length > 0 ? state.thinkingLevels : [state.thinking].filter(Boolean);
  const options = levels.map((level) => /** @type {[string, string]} */ ([level, level]));
  fill(el.thinking, [["default", "default"], ...options], state.thinkingChoice, ready);
  el.thinking.title = state.thinking ? `thinking: ${state.thinking}` : "Thinking level";

  // The row of the chat that is open names its model, so a new model is a new
  // row as well.
  renderSidebar();
}

/**
 * Fill a <select> without losing the choice when pi sends a new list.
 *
 * @param {HTMLSelectElement} node
 * @param {[string, string][]} options
 * @param {string} value
 * @param {boolean} enabled
 */
function fill(node, options, value, enabled) {
  node.replaceChildren(
    ...options.map(([key, label]) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = label;
      return option;
    }),
  );
  if (options.some(([key]) => key === value)) node.value = value;
  node.disabled = !enabled || options.length === 0;
}

async function pickModel() {
  const model = state.models.find((item) => modelKey(item) === el.model.value);
  if (!model) return;

  state.model = modelLabel(model);
  state.modelKey = modelKey(model);
  state.thinkingChoice = "default";
  renderPickers();

  await sendCommand({ type: "set_model", provider: model.provider ?? "", modelId: model.id });
  ask("get_available_thinking_levels");
}

function pickThinking() {
  const wanted = el.thinking.value;
  state.thinkingChoice = wanted;

  const level = wanted === "default" ? state.thinkingDefault : wanted;
  if (level && level !== state.thinking) void sendCommand({ type: "set_thinking_level", level });
  else renderPickers();
}

// -------------------------------------------------------------------- diff

let refreshGeneration = 0;

async function refreshGit() {
  if (!state.active) return;
  const id = state.active;
  const generation = ++refreshGeneration;

  try {
    status = /** @type {GitStatus} */ (
      await getJSON(`/api/git/status?id=${encodeURIComponent(id)}&base=${encodeURIComponent(state.base)}`)
    );
  } catch {
    status = null;
  }
  if (id !== state.active || generation !== refreshGeneration) return;

  el.base.textContent = status?.label ?? state.base;
  renderBranch();

  if (state.ui.files !== true || state.panel !== "diff") return;

  const problem = gitHint(status?.errorMessage);
  if (problem) {
    el.diffHead.replaceChildren();
    el.diffBody.replaceChildren(element("div", "diff-empty", problem));
    return;
  }

  const changed = status?.files ?? [];
  el.diffHead.replaceChildren(
    span(changed.length === 1 ? "1 file changed" : `${changed.length} files changed`, "diff-count"),
    ...(status?.truncated ? [span("list cut short", "diff-more")] : []),
  );

  // The patch of one file is a view of its own, so the panel stays as quick to
  // read as `git status` and does not paint a thousand lines nobody asked for.
  const rows = /** @type {HTMLElement[]} */ ([]);
  for (const group of statusGroups(changed)) {
    if (group.title.length > 0) rows.push(element("div", "status-group", group.title));
    rows.push(...group.files.map(statusRow));
  }
  if (rows.length === 0) rows.push(element("div", "diff-empty", "nothing changed"));
  el.diffBody.replaceChildren(...rows);
}

const git_messages = /** @type {Record<string, string>} */ ({
  "not a git repository": "no git repository in this folder",
  "diff too large": "diff too large to preview",
  "git diff failed": "git diff failed",
});

/** @param {string | null | undefined} message @returns {string} */
function gitHint(message) {
  if (!message) return "";
  return git_messages[message] ?? message;
}

/**
 * One line of `git status`: the two-letter code, the name, the folder behind it.
 *
 * @param {import("./panel.js").Changed} file
 */
function statusRow(file) {
  const node = element("button", "st-row");
  node.append(span(file.status, `st-code st-${statusClass(file.status)}`));
  node.append(span(file.display, "st-path"));

  const added = file.insertions ?? 0;
  const gone = file.deletions ?? 0;
  if (added > 0 || gone > 0) {
    const lines = element("span", "st-lines");
    if (added > 0) lines.append(span(`+${added}`, "st-plus"));
    if (gone > 0) lines.append(span(`−${gone}`, "st-minus"));
    node.append(lines);
  }

  node.onclick = () => openDiffView(file.path);
  node.title = "What changed here";
  return node;
}

/** @param {string} code */
function statusClass(code) {
  if (code === "?" || code === "A") return "new";
  if (code === "D") return "gone";
  if (code === "R" || code === "C") return "ren";
  if (code === "U") return "conf";
  return "mod";
}

/**
 * The branch of the chat in view, and what the base in the panel adds up to: commits when it is
 * another branch, lines when it is the working tree or the index.
 */
function renderBranch() {
  const name = status?.branch ?? "";
  el.branch.hidden = name.length === 0;
  const lines = status?.base === "working" || status?.base === "staged";
  const up = (lines ? status?.insertions : status?.ahead) ?? 0;
  const down = (lines ? status?.deletions : status?.behind) ?? 0;
  el.branch.replaceChildren(
    span(name),
    ...(up ? [span(`+${up}`, "branch-up")] : []),
    ...(down ? [span(`−${down}`, "branch-down")] : []),
  );
  const distance = lines ? `${up} added, ${down} removed` : `${up} ahead, ${down} behind`;
  el.branch.title = `${status?.label ?? state.base} · ${distance} · click to compare with something else`;
}

/** The two things a diff can be compared against in any folder, git or not. */
/** @type {[string, string][]} */
const fixedBases = [
  ["working", "Working changes"],
  ["staged", "Staged changes"],
];

/**
 * @typedef {{root: HTMLElement, anchor: HTMLElement, field: HTMLInputElement,
 *   list: HTMLElement, branches: string[], picked: number}} BaseMenu
 */

/** @type {BaseMenu | null} */
let baseMenu = null;

/**
 * Hung under whichever of the two places names a base, with branches fetched as it opens.
 *
 * @param {HTMLElement} anchor
 */
function openBaseMenu(anchor) {
  if (!state.active) return;
  if (baseMenu?.anchor === anchor) return closeBaseMenu();
  closeBaseMenu();
  closeMenu();

  const field = /** @type {HTMLInputElement} */ (element("input", "base-filter"));
  field.type = "search";
  field.placeholder = "filter";
  field.spellcheck = false;

  const list = element("div", "base-list");
  const root = element("div", "base-menu");
  root.append(field, list);
  document.body.append(root);

  /** @type {BaseMenu} */
  const menu = { root, anchor, field, list, branches: [], picked: 0 };
  baseMenu = menu;

  const draw = () => {
    const needle = field.value.trim().toLowerCase();
    const hit = (/** @type {string} */ text) => needle.length === 0 || text.toLowerCase().includes(needle);
    const changes = fixedBases
      .filter(([, label]) => hit(label))
      .map(([value, label]) => baseOption(value, label, state.base === value));
    const branches = menu.branches
      .filter(hit)
      .map((name) => baseOption(`branch:${name}`, name, state.base === `branch:${name}`));

    list.replaceChildren(
      baseGroup("Changes"),
      ...changes,
      ...(branches.length > 0 ? [baseGroup("Branches"), ...branches] : []),
    );
    menu.picked = 0;
    markBaseRow([...list.querySelectorAll(".base-option")], 0);
  };

  field.oninput = draw;
  field.onkeydown = /** @param {KeyboardEvent} event */ (event) => stepBaseMenu(event);

  const at = anchor.getBoundingClientRect();
  root.style.left = `${Math.max(8, Math.min(at.right - root.offsetWidth, window.innerWidth - root.offsetWidth - 8))}px`;
  root.style.top = `${at.bottom + 6}px`;

  draw();
  field.focus();

  void getJSON(`/api/git/branches?id=${encodeURIComponent(state.active)}`)
    .then((found) => {
      menu.branches = /** @type {{names: {name: string}[]}} */ (found).names.map((row) => row.name);
      if (baseMenu === menu) draw();
    })
    .catch(() => {});
}

function closeBaseMenu() {
  if (!baseMenu) return;
  baseMenu.root.remove();
  baseMenu = null;
}

/** @param {KeyboardEvent} event */
function stepBaseMenu(event) {
  const menu = baseMenu;
  if (!menu) return;
  const rows = [...menu.list.querySelectorAll(".base-option")];

  if (event.key === "Enter") {
    event.preventDefault();
    const value = /** @type {HTMLElement | null} */ (rows[menu.picked] ?? rows[0] ?? null)?.dataset.base ?? "";
    if (value) pickBase(value);
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (rows.length === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    menu.picked = (menu.picked + step + rows.length) % rows.length;
    markBaseRow(rows, menu.picked);
    rows[menu.picked]?.scrollIntoView({ block: "nearest" });
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeBaseMenu();
  }
}

/**
 * @param {Element[]} rows
 * @param {number} picked
 */
function markBaseRow(rows, picked) {
  rows.forEach((row, at) => {
    row.classList.toggle("active", at === picked);
  });
}

/** @param {string} label */
function baseGroup(label) {
  return element("div", "base-group", label);
}

/**
 * @param {string} value
 * @param {string} label
 * @param {boolean} current
 * @returns {HTMLElement}
 */
function baseOption(value, label, current) {
  const row = element("div", current ? "base-option on" : "base-option", label);
  row.dataset.base = value;
  row.onclick = /** @param {MouseEvent} event */ (event) => {
    event.stopPropagation();
    pickBase(value);
  };
  return row;
}

/** @param {string} value */
function pickBase(value) {
  closeBaseMenu();
  if (state.base === value) return;
  state.base = value;
  void refreshGit();
  refreshOpenDiff();
}

// -------------------------------------------------------------------- views

/**
 * A click in a list is a glance, not a keeper: the next glance takes the same
 * tab. Clicking the tab itself is what settles it.
 *
 * @param {string} path
 * @param {boolean} [preview]
 */
function openFileView(path, preview = true) {
  const next = openFile(state.views, path, preview);
  state.views = next.views;
  showView(next.active);
}

/** @param {string} path @param {boolean} [preview] */
function openDiffView(path, preview = true) {
  const next = openDiff(state.views, path, preview);
  state.views = next.views;
  showView(next.active);
}

/** @param {number} index */
function pickView(index) {
  const next = pinView(state.views, index);
  state.views = next.views;
  showView(next.active);
}

/** @param {number} index */
function closeView(index) {
  const gone = state.views[index];
  // A terminal is not just a look at something: the shell behind it is ours to
  // end, and a view that closes without it would leave a process running.
  if (gone?.kind === "terminal") return void closeShell(gone.shell);

  const next = closeFile(state.views, state.activeView, index);
  state.views = next.views;
  showView(next.active);
}

/**
 * Show one of the views in the main area. A file takes the middle entirely:
 * the composer sends to the chat, so leaving it under a file would promise that
 * a message lands in the file.
 *
 * @param {number} index
 */
function showView(index) {
  const at = Math.max(0, Math.min(index, state.views.length - 1));
  state.activeView = state.views[at]?.kind === "chat" || !state.views[at] ? 0 : at;

  const view = state.views[state.activeView];
  const chat = !view || view.kind === "chat";
  el.stream.hidden = !chat;
  el.composer.hidden = !chat;
  el.fileView.hidden = chat || view?.kind === "terminal";
  el.terminal.hidden = view?.kind !== "terminal";
  renderViews();

  renderFooter();

  if (view?.kind === "terminal") return showShell(view.shell);
  if (!chat && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (view?.kind === "file") void showFile(view.path);
  if (view?.kind === "diff") void showFileDiff(view.path);
}

/** The shell in front of the reader, or nothing. */
function terminalInView() {
  const view = state.views[state.activeView];
  return view?.kind === "terminal" ? view.shell : "";
}

function renderViews() {
  const chips = state.active ? state.views.map((view, index) => viewChip(view, index)) : [];
  el.views.replaceChildren(...chips, el.newItem);
}

/** @param {View} view @param {number} index */
function viewChip(view, index) {
  const node = element("div", `view${index === state.activeView ? " on" : ""}`);
  const tab = button(viewLabel(view), () => pickView(index));
  tab.className = `view-tab${view.kind === "file" || view.kind === "diff" ? (view.preview ? " preview" : "") : ""}`;
  tab.title =
    view.kind === "chat"
      ? "Back to the chat"
      : view.kind === "terminal"
        ? shellCwd(view.shell)
        : view.preview
          ? `${view.path} — preview, click to keep`
          : view.path;

  // The middle button closes, the way it does everywhere else a tab is open.
  tab.onmousedown = /** @param {MouseEvent} event */ (event) => {
    if (event.button === 1) event.preventDefault();
  };
  tab.onauxclick = /** @param {MouseEvent} event */ (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    closeView(index);
  };

  node.append(tab);

  if (view.kind !== "chat") {
    const close = button("✕", () => closeView(index));
    close.className = "view-close";
    close.title =
      view.kind === "file" ? "Close this file" : view.kind === "diff" ? "Close this diff" : "Close this terminal";
    node.append(close);
  }
  return node;
}

/**
 * A patch tab carries a Δ so it can sit next to the file it is about without
 * looking like the same thing twice.
 *
 * @param {View} view
 */
function viewLabel(view) {
  if (view.kind === "chat") return chatLabel();
  if (view.kind === "terminal") {
    const named = shellTitles.get(view.shell);
    const shell = state.shells.find((item) => item.id === view.shell);
    return `tty ${named ? truncate(named, 24) : named === "" ? "" : basename(shellCwd(view.shell))}${shell?.closed ? " · closed" : ""}`;
  }
  return view.kind === "diff" ? `Δ ${baseOf(view.path)}` : baseOf(view.path);
}

/** The chat is a tab too, and a tab wants a name rather than an id. */
function chatLabel() {
  const tab = active();
  if (!tab) return "chat";
  return isProjectCwd(tab.cwd) ? basename(tab.cwd) : "chat";
}

/** @param {string} path */
async function showFile(path) {
  const id = state.active;
  el.fileHead.replaceChildren(span(path, "file-path"));
  el.fileBody.replaceChildren(element("div", "file-empty", id ? "reading…" : "no chat is open"));
  if (!id) return;

  const content = /** @type {FileContent | null} */ (
    await getJSON(`/api/file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`).catch(() => null)
  );

  const shown = state.views[state.activeView];
  if (shown?.kind !== "file" || shown.path !== path) return;
  if (!content) {
    el.fileBody.replaceChildren(element("div", "file-empty", "this file could not be read"));
    return;
  }
  renderFile(content);
}

/** @param {FileContent} content */
function renderFile(content) {
  const meta = sizeOf(content.size) + (content.truncated ? " · first 512 kB" : "");
  const head = element("button", "file-copy", "copy path");
  head.onclick = async () => {
    await navigator.clipboard.writeText(content.path).catch(() => {});
    toast("path copied");
  };
  const patch = element("button", "file-copy", "see diff");
  patch.onclick = () => openDiffView(content.path, false);
  el.fileHead.replaceChildren(span(content.path, "file-path"), span(meta, "file-meta"), patch, head);

  if (content.binary) {
    el.fileBody.replaceChildren(element("div", "file-empty", "a binary file — nothing to show"));
    return;
  }

  const { lines, rest } = numberLines(content.text);
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const row = element("div", "code-line");
    row.append(span(String(line.n), "ln"), element("span", "lc", line.value.length > 0 ? line.value : " "));
    fragment.append(row);
  }
  if (rest > 0) fragment.append(element("div", "file-more", `${rest} more lines are not shown`));
  el.fileBody.replaceChildren(fragment);
}

/**
 * The patch of one file, read from git rather than from the file.
 *
 * @param {string} path
 */
async function showFileDiff(path) {
  const id = state.active;
  el.fileHead.replaceChildren(span(path, "file-path"));
  el.fileBody.replaceChildren(element("div", "file-empty", id ? "reading…" : "no chat is open"));
  if (!id) return;

  const url = `/api/git/diff?id=${encodeURIComponent(id)}&base=${encodeURIComponent(state.base)}&path=${encodeURIComponent(path)}`;

  let text = "";
  let trouble = "";
  try {
    text = await (await request(url)).text();
  } catch (error) {
    trouble = gitHint(error instanceof Error ? error.message : String(error)) ?? "the patch could not be read";
  }

  const shown = state.views[state.activeView];
  if (shown?.kind !== "diff" || shown.path !== path) return;
  if (trouble.length > 0) {
    el.fileBody.replaceChildren(element("div", "file-empty", trouble));
    return;
  }
  renderDiffView(path, parseDiff(text));
}

/** @param {string} path @param {import("./diff.js").FileDiff[]} parsed */
function renderDiffView(path, parsed) {
  const file = parsed.find((entry) => entry.path === path) ?? parsed[0];
  const open = element("button", "file-copy", "open file");
  open.onclick = () => openFileView(path, false);

  if (!file) {
    el.fileHead.replaceChildren(span(path, "file-path"), span("unchanged", "file-meta"), open);
    el.fileBody.replaceChildren(
      element("div", "file-empty", `this file is the same as in ${status?.label ?? state.base}`),
    );
    return;
  }

  const copy = element("button", "file-copy", "copy patch");
  copy.onclick = async () => {
    await navigator.clipboard.writeText(file.patch).catch(() => {});
    toast("patch copied");
  };
  el.fileHead.replaceChildren(span(path, "file-path"), span(`+${file.adds} −${file.dels}`, "file-meta"), open, copy);

  const fragment = document.createDocumentFragment();
  for (const hunk of file.hunks) {
    const box = element("div", "hunk");
    box.append(span(hunk.header, "hunk-head"));
    for (const row of hunk.rows) {
      const line = element("div", `row ${row.kind}`);
      line.append(
        span(row.old === null ? "" : String(row.old), "no"),
        span(row.new === null ? "" : String(row.new), "no"),
        span(row.text, "code"),
      );
      box.append(line);
    }
    fragment.append(box);
  }
  if (file.binary) fragment.append(element("div", "file-empty", "a binary file — no lines to show"));
  el.fileBody.replaceChildren(fragment);
}

/** @param {number} bytes */
function sizeOf(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Give back the panel first, then the file in front of it. */
function escapePanel() {
  if (state.ui.files === true) {
    void setPanel(false);
    return;
  }
  if (state.activeView > 0) closeView(state.activeView);
}

// --------------------------------------------------------------- settings

async function loadSettings() {
  const payload = await getJSON("/api/settings").catch(() => null);
  state.ui = payload?.ui ?? payload ?? {};
  applyUi();
}

function applyUi() {
  const root = document.documentElement;
  root.dataset.theme = state.ui.theme ?? "dark";
  root.style.setProperty("--sidebar-width", `${state.ui.sidebar_width ?? 264}px`);
  root.style.setProperty("--files-width", `${state.ui.files_width ?? 340}px`);
  root.style.fontSize = "14px";

  el.shell.classList.toggle("side-collapsed", state.ui.sidebar === false);
  el.sidePanel.hidden = state.ui.files !== true;
  renderPanelTabs();
  renderTight();
}

// --------------------------------------------------------------- side panel

function togglePanel() {
  return setPanel(state.ui.files !== true);
}

/** @param {boolean} open */
async function setPanel(open) {
  if (state.ui.files !== open) await saveUi({ files: open });
  if (open) void refreshPanel();
}

/** @param {"diff" | "files"} which */
function setPanelTab(which) {
  state.panel = which;
  renderPanelTabs();
  void refreshPanel();
}

function renderPanelTabs() {
  const diff = state.panel !== "files";
  el.panelDiff.hidden = !diff;
  el.panelFiles.hidden = diff;
  el.panelDiffTab.classList.toggle("on", diff);
  el.panelFilesTab.classList.toggle("on", !diff);
  // What to diff against only means something to the diff.
  el.base.hidden = !diff;
}

/** Whatever the panel is showing has to be read again. */
function refreshPanel() {
  if (state.ui.files !== true) return;
  if (state.panel === "files") {
    void loadFiles();
    return;
  }
  void refreshGit();
}

/** A patch that is being read follows the base and the work it is compared to. */
function refreshOpenDiff() {
  const view = state.views[state.activeView];
  if (view?.kind === "diff") void showFileDiff(view.path);
}

async function loadFiles() {
  const id = state.active;
  if (!id) return;

  const payload = await getJSON(`/api/files?id=${encodeURIComponent(id)}`).catch(() => null);
  if (id !== state.active) return;

  state.files = Array.isArray(payload?.files) ? payload.files : [];
  state.filesTruncated = !!payload?.truncated;
  renderFileList();
}

/** The folder the Files tab is showing. A query ignores it: typing searches the project. */
let filesDir = "";

/** @param {string} dir */
function goDir(dir) {
  filesDir = dir;
  el.fileFilter.value = "";
  renderFileList();
  el.fileList.scrollTop = 0;
}

function renderFileList() {
  const query = el.fileFilter.value.trim();
  renderCrumbs(query);

  /** @type {Node[]} */
  let nodes;
  if (query.length > 0) {
    nodes = fileRows(state.files, query).map((row) => fileRow(row.name, row.path, row.ranges, row.dir));
  } else {
    const tree = fileTree(state.files, filesDir);
    nodes = [
      ...(filesDir === "" ? [] : [upRow()]),
      ...tree.dirs.map(dirRow),
      ...tree.files.map((entry) => fileRow(entry.name, entry.path, [])),
    ];
  }

  if (nodes.length === 0)
    nodes.push(element("div", "file-empty", query.length > 0 ? "nothing matches" : "nothing here"));
  if (state.filesTruncated) nodes.push(element("div", "file-more", "the folder holds more — keep typing"));
  el.fileList.replaceChildren(...nodes);
}

/** @param {string} query */
function renderCrumbs(query) {
  el.fileCrumbs.textContent = "";
  if (query.length > 0) {
    el.fileCrumbs.hidden = false;
    el.fileCrumbs.append(span(`everywhere for ${query}`, "crumb"));
    return;
  }

  const trail = trailOf(filesDir);
  el.fileCrumbs.hidden = trail.length === 0;
  if (trail.length === 0) return;

  const up = button("↑", () => goDir(dirOf(filesDir)));
  up.className = "crumb crumb-up";
  up.title = "One folder up";
  el.fileCrumbs.append(up);

  for (const step of trail) {
    el.fileCrumbs.append(span("›", "crumb-sep"));
    const crumb = button(step.name, () => goDir(step.path));
    crumb.className = "crumb";
    el.fileCrumbs.append(crumb);
  }
}

function upRow() {
  const node = element("button", "file-row");
  node.append(span("↑", "file-glyph"), span("..", "file-name"));
  node.onclick = () => goDir(dirOf(filesDir));
  return node;
}

/** @param {import("./panel.js").DirRow} row */
function dirRow(row) {
  const node = element("button", "file-row");
  node.append(span("▸", "file-glyph"), span(row.name, "file-name"), span(String(row.count), "file-dir"));
  node.onclick = () => goDir(row.path);
  node.title = row.path;
  return node;
}

/**
 * @param {string} name
 * @param {string} path
 * @param {[number, number][]} ranges
 * @param {string} [dir] dimmed behind the name, when the row is not already in it
 */
function fileRow(name, path, ranges, dir = "") {
  const node = element("button", "file-row");
  const label = element("span", "file-name");
  label.append(highlight(name, ranges, "mark"));
  node.append(label);
  if (dir.length > 0) node.append(span(dir, "file-dir"));
  node.onclick = () => openFileView(path);
  node.title = path;
  return node;
}

async function showSettings() {
  el.settingsModal.hidden = false;
  el.settingsModal.replaceChildren(
    card(
      "Settings",
      section(
        "Chat",
        choice(
          "sendmode",
          "While Pi is working",
          [
            ["steer", "Steer into the run"],
            ["queue", "Queue after the run"],
          ],
          state.ui.send_mode === "queue" ? "queue" : "steer",
          (value) => {
            void saveUi({ send_mode: /** @type {"steer" | "queue"} */ (value) });
            // The chat in view has to be told which of its two queues to empty at
            // once, and the other one is left alone.
            void sendCommand({ type: steeringCommand(), mode: "all" });
            renderQueue();
          },
        ),
        toggle(
          "thinking",
          "Show thinking",
          state.ui.show_thinking === true,
          (on) => void saveUi({ show_thinking: on }),
        ),
        toggle("enter", "Enter sends", state.ui.send_on_enter !== false, (on) => void saveUi({ send_on_enter: on })),
      ),
      section(
        "Window",
        choice(
          "theme",
          "Theme",
          [
            ["dark", "Dark"],
            ["light", "Light"],
          ],
          state.ui.theme === "light" ? "light" : "dark",
          (value) => void saveUi({ theme: value }),
        ),
        toggle("sidebar", "Sidebar", state.ui.sidebar !== false, (on) => void saveUi({ sidebar: on })),
      ),
      actionsRow(),
    ),
  );
}

/** @param {Partial<Ui>} patch */
async function saveUi(patch) {
  try {
    const ui = await postJSON("/api/settings", { ui: patch });
    if (ui) state.ui = ui;
    applyUi();
    render();
  } catch (error) {
    toast(error instanceof Error ? error.message : "save failed");
  }
}

function actionsRow() {
  const row = element("div", "row-buttons");
  const out = button("Sign out", async () => {
    await postJSON("/api/logout", {}).catch(() => {});
    location.reload();
  });
  out.className = "button ghost";
  const close = button("Close", () => {
    el.settingsModal.hidden = true;
  });
  close.className = "button primary";
  row.append(out, element("span", "spacer"), close);
  return row;
}

// ----------------------------------------------------------------- helpers

/** @returns {TabInfo | null} */
function active() {
  return state.tabs.find((tab) => tab.id === state.active) ?? null;
}

/** @param {TabInfo} tab */
function labelOf(tab) {
  if (tab.sessionName && tab.sessionName.length > 0) return tab.sessionName;
  const resume = state.sessions.find((entry) => entry.path === tab.sessionPath);
  if (resume?.first_text) return firstLine(resume.first_text);
  if (!isProjectCwd(tab.cwd)) return "Chat";
  return basename(tab.cwd);
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [content]
 * @returns {HTMLElement}
 */
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

/** Filled in the first time a spinner is built, from the stylesheet. */
let spinPeriod = 0;

/**
 * The ring that says something is happening. The transcript and the sidebar are
 * rebuilt while pi works, and a new element starts its animation at zero, so a
 * rebuilt spinner only jitters. Starting it at the point the clock has already
 * reached makes every replacement a continuation of the same turn.
 *
 * @returns {HTMLElement}
 */
function spinner() {
  const node = element("span", "spinner");
  turnTo(node);
  return node;
}

/**
 * @param {HTMLElement} node
 */
function turnTo(node) {
  if (spinPeriod === 0) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--spin-period");
    const value = Number.parseFloat(raw);
    spinPeriod = Number.isFinite(value) && value > 0 ? (raw.includes("ms") ? value : value * 1000) : 900;
  }
  node.style.animationDelay = `${-(Date.now() % spinPeriod)}ms`;
}

/**
 * @param {string} value
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function span(value, className) {
  return element("span", className, value);
}

/**
 * @param {string} label
 * @param {() => void} onclick
 * @returns {HTMLButtonElement}
 */
function button(label, onclick) {
  const node = /** @type {HTMLButtonElement} */ (element("button", "button", label));
  node.onclick = onclick;
  return node;
}

const ICONS = {
  copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H5.5A1.5 1.5 0 0 0 4 5.5V13"/></svg>',
  fork: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="7" cy="5.5" r="2.2"/><circle cx="17" cy="5.5" r="2.2"/><circle cx="12" cy="18.5" r="2.2"/><path d="M7 7.7v1.8a2.2 2.2 0 0 0 2.2 2.2h5.6a2.2 2.2 0 0 0 2.2-2.2V7.7"/><path d="M12 11.7v4.6"/></svg>',
};

/**
 * @param {"copy" | "fork"} name
 * @param {string} label
 * @param {() => void} onclick
 * @returns {HTMLButtonElement}
 */
function iconButton(name, label, onclick) {
  const node = /** @type {HTMLButtonElement} */ (element("button", "button icon"));
  node.innerHTML = ICONS[name];
  node.setAttribute("aria-label", label);
  node.onclick = onclick;
  return node;
}

/**
 * @param {string} name
 * @param {string} label
 * @param {boolean} checked
 * @param {(value: boolean) => void} onchange
 * @returns {HTMLElement}
 */
function toggle(name, label, checked, onchange) {
  const row = /** @type {HTMLElement} */ (element("label", `setting ${name}`));
  const box = /** @type {HTMLInputElement} */ (element("input"));
  box.type = "checkbox";
  box.checked = checked;
  box.onchange = () => onchange(box.checked);
  row.append(span(label), box);
  return row;
}

/**
 * @param {string} name
 * @param {string} label
 * @param {[string, string][]} options
 * @param {string} value
 * @param {(value: string) => void} onchange
 * @returns {HTMLElement}
 */
function choice(name, label, options, value, onchange) {
  const row = /** @type {HTMLElement} */ (element("label", `setting ${name}`));
  const select = /** @type {HTMLSelectElement} */ (element("select"));

  for (const [at, text] of options) {
    const option = document.createElement("option");
    option.value = at;
    option.textContent = text;
    option.selected = at === value;
    select.append(option);
  }

  select.onchange = () => onchange(select.value);
  row.append(span(label), select);
  return row;
}

/**
 * @param {string} title
 * @param {HTMLElement[]} children
 * @returns {HTMLElement}
 */
function card(title, ...children) {
  const box = element("div", "card");
  box.append(span(title, "card-title"), ...children);
  return box;
}

/**
 * @param {string} title
 * @param {HTMLElement[]} rows
 * @returns {HTMLElement}
 */
function section(title, ...rows) {
  const lines = element("div", "setting-rows");
  lines.append(...rows);
  const box = element("div", "setting-group");
  box.append(span(title, "setting-head"), lines);
  return box;
}

/** @param {string} label */
function groupLabel(label) {
  return element("div", "group-label", label);
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} key
 * @returns {Map<string, T[]>}
 */
function groupBy(items, key) {
  const out = new Map();
  for (const item of items) {
    const list = out.get(key(item)) ?? [];
    list.push(item);
    out.set(key(item), list);
  }
  return out;
}

/** @param {import("./protocol.js").Usage} usage */
function usageLine(usage) {
  const parts = [`${tokens(usage.input ?? 0)} in`, `${tokens(usage.output ?? 0)} out`];
  if (usage.cacheRead) parts.push(`${tokens(usage.cacheRead)} Cache`);
  if (usage.cost?.total) parts.push(cost(usage.cost.total));
  return parts.join(" · ");
}

function grow() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(Number(el.input.scrollHeight), 260)}px`;
}

/** @param {string} message */
/** @type {ReturnType<typeof setTimeout> | null} */
let toastTimer = null;

/**
 * @param {string} message
 * @param {number} [ms]
 */
function toast(message, ms = 4500) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
    toastTimer = null;
  }, ms);
}
