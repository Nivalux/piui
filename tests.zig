//! Zig test suite: one binary, run with `zig build test`.

test {
    _ = @import("tests/framing_test.zig");
    _ = @import("tests/protocol_test.zig");
    _ = @import("tests/sessions_test.zig");
    _ = @import("tests/fuzz_test.zig");
    _ = @import("tests/git_test.zig");
    _ = @import("tests/files_test.zig");
}
