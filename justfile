# piui – the few commands worth remembering.  Run:  just <task>
addr := "127.0.0.1:7788"

# what a reviewer runs before pushing: format, every test, and the binary
check: fmt-check test build

# build the server into zig-out/bin/piui
build:
    zig build

# every test: zig units + fuzz replay, js logic, jsdoc types. The browser
# tests are part of it and skip themselves where there is no chromium.
test:
    zig build test

# put this build in front of the service; nothing that fails a test gets copied
live: test build
    cp zig-out/bin/piui zig-out/bin/piui-live

# the server, serving web/ embedded
run ADDR=addr:
    zig build run -- --addr {{ADDR}}

# the server with web/ read from disk, so frontend edits need no rebuild
dev ADDR=addr:
    zig build run -- --web web --addr {{ADDR}}

# zig tests only
test-zig:
    zig build test --summary all

# browser-free js logic only (reducer, filter, rate, commands, format, diff, protocol)
test-js:
    node --test "web/test/**/*.test.js"

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

fmt-check:
    @zig fmt --check .

clean:
    rm -rf .zig-cache zig-out
