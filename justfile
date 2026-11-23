# piui – the few commands worth remembering.  Run:  just <task>
#
# `just --list` shows the last line of the comment above a recipe, so the line
# touching a recipe is its summary and a longer note goes above a blank line.
addr := "127.0.0.1:7788"

# what a reviewer runs before pushing: format, every test, and the binary
check: fmt-check lint test build

# build the server into zig-out/bin/piui
build:
    zig build

# every test: zig units + fuzz replay, js logic, jsdoc types, browser
#
# `zig build test` runs the js tests and tsc too, and the browser file is in the
# same glob, so this is everything the machine can test. It needs the nix shell
# for chromium and playwright; without them the browser file skips itself.

# all of it: zig, js, types, browser
test:
    zig build test

# put this build in front of the running service
#
# Nothing that fails a test gets copied. It is a rename, not a write: the
# service holds the old file open for execution and keeps serving that inode
# until systemctl --user restart piui.service.

# build, test, hand the binary to the service; a restart still follows
live: test build
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

# the js logic tests, browser file aside
#
# Reducer, filter, rate, commands, format, diff, protocol, tabs, dom. The browser
# file lives in web/test/browser so that this one stays a few seconds long.

# js logic only, no browser
test-js:
    node --test "web/test/*.test.js"

# the browser tests on their own
#
# Both chromium and playwright come from this shell: PIUI_CHROMIUM is the browser
# to drive, PLAYWRIGHT_CORE the library that drives it, and the file skips itself
# when either is missing. Built first, because the server under test carries web/
# inside it, so a binary from before an edit would answer for that edit.

# the browser tests, against a fresh build
test-browser: build
    PIUI_BINARY="$PWD/zig-out/bin/piui" node --test --test-reporter=spec web/test/browser/browser.test.js

# one browser test, by part of its name
test-browser-one PATTERN: build
    PIUI_BINARY="$PWD/zig-out/bin/piui" node --test --test-reporter=spec --test-name-pattern="{{PATTERN}}" web/test/browser/browser.test.js

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
