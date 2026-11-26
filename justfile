# piui – the few commands worth remembering.  Run:  just <task>
#
# `just --list` shows the last line of the comment above a recipe, so the line
# touching a recipe is its summary and a longer note goes above a blank line.
addr := "127.0.0.1:7788"

# A suite that cannot hang: a minute to a test, and the runner leaves whatever child forgot to.
node_flags := "--test-timeout=15000 --test-force-exit"

# what a reviewer runs before pushing: format, every test, and the binary
check: fmt-check lint test build

# build the server into zig-out/bin/piui
build:
    zig build

# every test: zig units + fuzz replay, js logic, jsdoc types, browser
#
# Needs the nix shell; without chromium and playwright the browser files skip themselves.

# all of it: zig, js, types, browser
test:
    zig build test

# put this build in front of the running service
#
# Nothing that fails a test gets copied. It is a rename, not a write: the
# service holds the old file open for execution and keeps serving that inode
# until systemctl --user restart piui.service.

# zig units, js logic, jsdoc types, and the browser files that stay honest under load
#
# The terminal window and the terminal font test are skipped: run together with
# the rest they lose on a build that changed nothing near them. `just check`
# still runs them.

# what a build has to survive before it goes in front of the running service
test-live: test-zig test-js typecheck build
    PIUI_BINARY="$PWD/zig-out/bin/piui" node --test {{node_flags}} --test-skip-pattern="terminal window|terminal font" web/test/browser/*.test.js

# build, test, hand the binary to the service; a restart still follows
live: test-live
    cp zig-out/bin/piui zig-out/bin/piui-live.new
    mv zig-out/bin/piui-live.new zig-out/bin/piui-live

# the server, serving web/ embedded
run ADDR=addr:
    zig build run -- --addr {{ADDR}}

# the server with web/ read from disk, so frontend edits need no rebuild
dev ADDR=addr:
    zig build run -- --web web --addr {{ADDR}}

# zig units and the fuzz replay, nothing else
test-zig:
    zig build test-zig --summary all

# one zig test, by part of its name
test-zig-one PATTERN:
    zig build test-zig --summary all -Donly="{{PATTERN}}"

# the js logic tests, browser files aside
#
# The browser files live in web/test/browser so this lot stays a few seconds long.

# js logic only, no browser
test-js:
    node --test {{node_flags}} "web/test/*.test.js"

# the browser tests on their own
#
# One file, one server, one page: the files run at the same time, so the suite is
# as long as its slowest file. Built first, because web/ lives inside the binary.

# the browser tests, against a fresh build
test-browser: build
    PIUI_BINARY="$PWD/zig-out/bin/piui" node --test {{node_flags}} --test-reporter=spec web/test/browser/*.test.js

# one browser test, by part of its name
test-browser-one PATTERN: build
    PIUI_BINARY="$PWD/zig-out/bin/piui" node --test {{node_flags}} --test-reporter=spec --test-name-pattern="{{PATTERN}}" web/test/browser/*.test.js

# typecheck the js against its own jsdoc types
typecheck:
    tsc --project web

# render a copy of a chat in a throwaway server and list its transcript blocks
peek *ARGS:
    node scripts/peek.mjs {{ARGS}}

# the long fuzz replay; a finding becomes a fixture test, never a generator
test-fuzz STEPS="200000":
    zig build test -Dfuzz={{STEPS}}

fmt:
    zig fmt .
    biome format --write .

fmt-check:
    @zig fmt --check .
    @biome format .

# the lint groups that find mistakes rather than taste
#
# Correctness, suspicious, complexity. Off where this codebase is deliberate:
# !important on [hidden], and literal spaces in a regex matching a patch line.

# biome lint
lint:
    @biome lint .

clean:
    rm -rf .zig-cache zig-out
