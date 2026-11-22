# piui – Plan v1

A lightweight web UI on top of the existing `pi` (no changes to pi, no sessions of our own).

## Non-goals (v1)
Multi-user/auth, editing files, terminal emulation, forks/trees/compaction UI, mobile.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Server | **Zig 0.17.1** (in nixpkgs) | Everything is in std: `std.http.Server` (keep-alive + chunked → SSE), `std.Thread`, `std.json.Scanner`, `std.process.Child`, `std.testing`. 0 deps, ~1 MB binary. |
| Client | **JS + JSDoc, no framework, no bundler** | `tsc --noEmit --allowJs --checkJs --strict` checks the `.js` directly (TS 7.0.2, native). No transpile layer: the browser loads exactly the files that were checked. Tests: `node --test` on the same `.js`. |
| Format | **Biome for js/mjs/css, `zig fmt` for zig** | One static binary out of nixpkgs, so the repo keeps its no-`node_modules` rule. `just fmt` writes, `just check` fails on anything unformatted. |
| Lint | **Biome: correctness + suspicious + complexity** | The three groups that find mistakes rather than taste. `just lint`, and part of `just check`. Off where the code is deliberate: `useDomNodeTextContent` (tests read rendered `innerText`), `noDescendingSpecificity` (hand-ordered stylesheet), `noImportantStyles`, `noAdjacentSpacesInRegex`. |
| Transport | **SSE (server→client) + POST (client→server)** | `std.http.Server` with `transfer_encoding = .chunked`; WebSocket only once it is actually needed. |
| Markdown | vendored `marked.min.js` (1 file) or our own mini renderer | no build step. |

Verified (not from memory): `zig env` → `lib/zig/std/http/Server.zig` with `keep_alive`/`transfer_encoding`, `lib/zig/std/Io.zig:28-44` (`Threaded`, `Evented` via io_uring/kqueue, `fiber`, `Dispatch`), `json.zig:69` (`Scanner`).

Two remaining risks and how they are contained:
- **`std.Io` is WIP** (naming/API breakage between 0.15→0.17). piui therefore uses **no** Evented/Uring/Fiber: one `std.Thread` per pi child, blocking pipe reads, blocking chunked SSE writes. The part that churns is the part we do not touch.
- **Picking ~30 pi event variants out of `json.Value` by hand** is the real grunt work. Hence: one file `protocol.zig`, table-driven, everything into a closed `union(enum)`; the rest of the code never sees a `json.Value`. Covered by fixture tests.

Why not Go/Rust: Go would be the lower-risk default (0 deps, `encoding/json` into structs saves boilerplate, stable API, `go:embed` for assets) – given up in favour of binary size and Zig. Rust: `tokio`+`axum`+`serde` ≈ 100 crates, which contradicts "narrow".

One Zig particularity: `@embedFile` cannot take directories. `build.zig` turns the assets into a generated manifest (`web_assets.zig`: path → `@embedFile`); in dev mode a fallback serves `web/` from disk so editing and reloading needs no rebuild.

## Architecture

```
Browser (JS+JSDoc, embedded)  --SSE / POST-->  piui (Zig)  --stdin/stdout JSONL-->  pi --mode rpc   (1 child per session)
                                        |
                                        +-- ~/.pi/agent/sessions/**  (read only: session index)
                                        +-- git CLI inside the project folder  (status/diff)
                                        +-- ~/.piui/config.json       (diff base per project, default)
```

- One `pi` child per open chat tab, long-lived; idle timeout (~15 min) plus a transparent restart, because the session path makes a restart lossless.
- Exactly one child per session file (never a second writer on the same file).
- Framing strictly per `docs/rpc.md`: one line per record, LF only as the boundary (U+2028/U+2029 are legal inside strings → no generic line reader), correlation via `id`, `agent_settled` as the end.
- Chat without a project folder: piui creates `~/.piui/scratch/<id>` and starts pi there; the UI shows "no project" and hides the git panel. Those stay ordinary pi sessions.

## HTTP API

```
GET  /                          UI
GET  /api/sessions              index: [{path,cwd,name,title,lastActive,running}]
POST /api/sessions              {cwd|null} -> new chat (scratch when null)
POST /api/sessions/open         {path} -> attach a child to a session
GET  /api/stream?tab=<id>       SSE: pi events (passed through) + piui's own events
POST /api/cmd                   {tab, ...rpcCommand} -> to pi's stdin
GET  /api/git/status?cwd=       {base, files:[{path,status,adds,dels}], totals}
GET  /api/git/diff?cwd=&path=&base=   unified diff (parsed to JSON for rendering)
GET  /api/file?cwd=&path=       file content (inside cwd only, traversal guard)
GET/POST /api/settings          diff base per project + global default
```

## UI (from the screenshots)

Three zones: left sessions (collapsible) · middle chat with tabs · right files/changes (collapsible).

**Left** (modelled on t3code): groups `Working` / `Settled`, sorted by time descending. Row = project badge (`basename(cwd)`), title (session name, otherwise the first user message), on the right "3 h ago" or "Working 17m". Search/rename.

**Middle**: tab bar with chat tabs and opened file/diff tabs. Transcript as narrow lines: `Thinking` (clickable, expandable), tool line = icon + name + short argument form (truncated), output collapsed; user/assistant text as Markdown. Footer "Worked for Xs" + cost/tokens. Composer at the bottom with model and thinking selectors, abort button.
Images from `tool_result` (`ImageContent`, base64) as a thumbnail (~120 px), click → lightbox at full size.

**Right**: tabs `Files` (tree) and `Changes`. Changes grouped by directory, per file a `+A -D` counter and a status glyph; the header shows the base selector and the totals; clicking a file → diff tab in the middle (with hunk headers, line numbers, +/- background).

**Diff base** (the Paseo fix): switchable between
`working` (uncommitted, default) · `staged` · `branch:<name>` · `commit:<sha>`.
Merged in `~/.piui/config.json` per repository path plus a global default, written on change (atomically). Survives panel toggles, reloads and switching browsers – panel state (collapsed/width) stays in localStorage.

## Types & tests

- `web/protocol.js` (JSDoc `@typedef`) and `src/protocol.zig` describe the same records.
- Shared fixtures in `testdata/` (recorded pi RPC streams and `git status --porcelain=v2` output) are decoded by **both** test runs → conformance without codegen.
- Zig (`zig build test`): framing (LF-only, U+2028/29, CRLF), response correlation, session index scan including cache invalidation via (mtime,size), diff base → command builder, porcelain parser, path guard. Fake-pi as a test binary with canned JSONL.
- JS (`node --test`): pure reducer `reduce(state, event) -> state` without DOM (streaming reconstruction from `message_update`, tool status, image blocks), `formatRelativeTime`, tool summary, diff classification.
- JSDoc boundary: `transcript.js` (the reducer) and `protocol.js` fully annotated and strict; the DOM building blocks deliberately loose, because `checkJs` is weaker than TS at DOM narrowing. `tsconfig.json` with `strict`, `checkJs`, `noEmit`, `allowJs`.
- Browser (`web/test/browser.test.js`): the real page in chromium against the real server, with `web/test/fake-pi.mjs` replaying a canned turn — no model, no key, no network. Covers what only a browser sees: a fold opening under the click while its row is rewritten, the counts and the failure mark of a closed tool row, where the page scrolls. Needs the nix shell (chromium + playwright-core); outside it the file skips itself.

## Milestones

- **M0 Scaffold** – `build.zig`, asset manifest, `piui serve` (127.0.0.1 only), `/healthz`; `zig build test` + `tsc --noEmit --checkJs` + `node --test` in one `justfile`/`shell.nix`. *Done when all three test suites are green.*
- **M1 Chat slice** – start a pi child, pass SSE through, transcript (text/thinking/tool), composer, abort, model/thinking choice, chat with and without a project folder. *Done when a real pi conversation shows up live and survives a reload.*
- **M2 Session panel** – index over `~/.pi/agent/sessions`, Working/Settled groups, resume, rename, badges/times. *Done when pi sessions from pi and from piui look identical.*
- **M3 Git panel** – status/diff, base switcher with persistence, diff tab in the middle, image thumbnails. *Done when a base change survives a reload.*
- **M4 Polish** – panel collapsed state, closing/tidying tabs, keyboard (`Ctrl+L` focus, `Ctrl+B`/`Ctrl+E` panels), SSE reconnect, error/empty states, theme like the screenshots.

## Open points

1. Idle timeout of the pi children: inherit the value from pi's settings or keep our own?
2. pi's extension UI dialogs (`rpc-extension-ui.md`): v1 only decline + toast, or rough confirmation dialogs?
3. Untracked files in the diff: show them as fully added (yes?) and ignore `.gitignore` behaviour?
