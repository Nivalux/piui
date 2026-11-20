# piui – the few commands worth remembering.  Run:  just <task>
addr := "127.0.0.1:7788"

# what a reviewer runs before pushing: format, every test, and the binary
check: fmt-check test build

# build the server into zig-out/bin/piui
build:
    zig build

# every test: zig units + fuzz replay, browser-free js logic, jsdoc types
test:
    zig build test

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

# the long fuzz replay; a finding becomes a fixture test, never a generator
test-fuzz STEPS="200000":
    zig build test -Dfuzz={{STEPS}}

fmt:
    zig fmt .

fmt-check:
    @zig fmt --check .

clean:
    rm -rf .zig-cache zig-out
