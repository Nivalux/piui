# piui

Small web front end for pi. Zig server (`src/`), framework-free JS client (`web/`),
no node_modules, no bundler. `nix-shell` provides the toolchain; `just --list` the commands.

## Tooling & Execution
- Always run `just check`, `zig build`, `zig test`, `nix-shell` builds/downloads, and servers via `job_run` + `job_wait` (never `bash`).
- Run `just check` (format, lint, tests, build) before committing; never commit if it fails.

## Comments (Overrides global zero-comments rule strictly as defined below)
- Forbidden everywhere: file headers, inline `//` comments, section banners, change notes, commented-out code, `TODO`, and any comments inside test bodies.
- Allowed ONLY: a single-sentence Zig `///` or JS `/** ... */` doc comment on a public/non-obvious declaration (invariants, return contract, or JS `@param` type).
- If a name needs explanation, rename the identifier instead of adding a comment.
- Before calling `write` or `edit`, strip all inline `//` comments and multi-sentence doc blocks from your payload.

## Live service
`piui.service` (systemd user unit) runs `zig-out/bin/piui-live`. Ask before copying a
build onto it or restarting it; state what would change first.
