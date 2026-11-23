# piui

Small web front end for pi. Zig server (`src/`), framework-free JS client (`web/`),
no node_modules, no bundler. `nix-shell` provides the toolchain; `just --list` the commands.

Use the job tool for all longer running tasks.

## Comments

Write none. No file headers, no narration of what the next lines do, no notes about
why a change was made, no commented-out code, no `TODO`.

A doc comment on a declaration is allowed when the declaration is not obvious from
its name: what it returns, the invariants a caller must keep, a `@param` type. One
short sentence, not a paragraph. If a name needs a comment to be understood, rename it.

Test names are the documentation for behaviour. Test bodies get no comments.

## Checks

`just check` before committing: format, lint, every test, build. Nothing that fails
it gets committed.

## Live service

`piui.service` (systemd user unit) runs `zig-out/bin/piui-live`. Ask before copying a
build onto it or restarting it; say what would change first.
