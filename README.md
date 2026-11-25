# piui

A small web front end for the [pi](https://github.com/badlogic/pi-mono) coding agent: several chats in one
window, each in its own project folder, with the diff, the files and a real terminal next to the transcript.

One Zig binary with the client inside it. No node_modules, no bundler, no framework — the browser loads the
same `.js` files that were type checked.

## What it does

- chats grouped by project, filtered with an fzf-style box, restored when the server comes back
- settled chats stay until manually closed; idle Pi workers are pooled and working chats keep an exclusive worker
- transcript of a turn: thoughts, tool lines with their diff bars, images the agent read, the answer
- diff panel and file list of the chat's repository, with a base to compare against (working, staged, any branch)
- a PTY terminal per project, selection copied out and the clipboard pasted in
- pi's own `/commands` in the composer, model and thinking level per chat

## Requirements

- `pi` used from the account piui runs as — it reads `~/.pi/agent/sessions` and pools `pi --mode rpc` workers through the public RPC interface
- `git` on `PATH` for the diff panel
- Zig 0.17.1 or newer, only to build from source

## Quick start (Linux)

```sh
zig build
./zig-out/bin/piui
```

Open <http://127.0.0.1:7788>. The login token is printed at start and kept in `~/.piui/token` with mode 0600.
`piui --help` lists the options; each of them also has a place in `~/.piui/config.json` under `"server"`, so a
port or a path to `pi` can be set once.

## With Nix

Any distribution, from a checkout:

```sh
nix-shell                              # zig, node, typescript, biome, playwright, chromium
nix-shell --run 'zig build'
nix-shell --run 'just run'             # or: just dev 127.0.0.1:7788, which serves web/ from disk
```

Build it as a package:

```sh
nix-build -E 'with import <nixpkgs> {}; callPackage ./package.nix {}'
./result/bin/piui
```

The check phase runs the zig units, the fuzz replay, the js logic and the jsdoc types; the browser suite stays with
`just test`, since it drives a real chromium. Pass `doCheck = false` to `callPackage` to build without asking.

## NixOS

`package.nix` is a plain derivation, so it can be built straight out of a pinned source tree — a tack pin, a
`fetchTree`, or a path inside your configuration:

```nix
{ pkgs, ... }:

let
  piui-src = import ./pins/piui;              # a fetched source tree, e.g. from tack
  piui = pkgs.callPackage "${piui-src}/package.nix" { };
in
{
  environment.systemPackages = [ piui ];

  # Or run it as a service under your own user, since it needs your pi sessions and your projects.
  systemd.user.services.piui = {
    description = "piui — web front end for pi";
    wantedBy = [ "default.target" ];
    serviceConfig = {
      ExecStart = "${piui}/bin/piui --addr 127.0.0.1:7788";
      Restart = "on-failure";
    };
  };
}
```

`pi` is deliberately not baked into the package: point at it with `--pi` or `server.pi` in the config, so one
build works with whichever pi you have.

## Development

```sh
nix-shell
just check          # format, lint, zig units + fuzz replay, js, jsdoc types, browser tests, build
just test-browser   # the Playwright tests only
just --list         # the rest
```

| Path | What lives there |
|---|---|
| `src/` | the server: HTTP + SSE, the hub of pi processes, pty, git, sessions |
| `web/` | the client, plain JS with JSDoc types, loaded unmodified by the browser |
| `tests/`, `testdata/` | Zig tests and the fixtures they replay |
| `web/test/` | `node --test` for the logic, `web/test/browser/` for the page |
| `build.zig` | embeds `web/` into the binary and wires the test steps |

## License

GPL-2.0-only — see [LICENSE](LICENSE).
