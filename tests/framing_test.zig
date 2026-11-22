const std = @import("std");
const Io = std.Io;
const testing = std.testing;
const piui = @import("piui");
const framing = piui.framing;

const stream = @embedFile("../testdata/stream.jsonl");

/// Runs `data` through the framer with reads capped at `piece_size` bytes.
fn collect(allocator: std.mem.Allocator, data: []const u8, piece_size: usize) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (out.items) |item| allocator.free(item);
        out.deinit(allocator);
    }

    var step_buffer: [512]u8 = undefined;
    var source = testing.Reader.init(&step_buffer, &.{.{ .buffer = data }});
    source.artificial_limit = .limited(piece_size);

    var records = framing.Records.init(allocator, &source.interface);
    defer records.deinit();

    while (try records.next()) |record| {
        try out.append(allocator, record);
    }
    return out.items;
}

/// The framer must return exactly the non-empty lines of its input, in order, no matter where the
/// pipe happens to cut them.
fn expectLines(allocator: std.mem.Allocator, data: []const u8, piece_size: usize) !void {
    const got = try collect(allocator, data, piece_size);
    defer allocator.free(got);

    var index: usize = 0;
    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |candidate| {
        if (candidate.len == 0) continue;
        try testing.expectEqualStrings(trimCr(candidate), got[index]);
        index += 1;
    }
    try testing.expectEqual(index, got.len);
}

fn trimCr(line: []const u8) []const u8 {
    if (line.len > 0 and line[line.len - 1] == '\r') return line[0 .. line.len - 1];
    return line;
}

test "one record per line" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();

    const got = try collect(arena_state.allocator(), "{\n}\n", 4096);
    try testing.expectEqual(@as(usize, 2), got.len);
    try testing.expectEqualStrings("{", got[0]);
    try testing.expectEqualStrings("}", got[1]);
}

test "records split across reads are rejoined" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const data = "{\"type\":\"agent_start\"}\n{\"type\":\"agent_settled\"}\n";
    for ([_]usize{ 1, 7, 4096 }) |size| {
        const got = try collect(arena, data, size);
        try testing.expectEqual(@as(usize, 2), got.len);
        try testing.expectEqualStrings("{\"type\":\"agent_start\"}", got[0]);
        try testing.expectEqualStrings("{\"type\":\"agent_settled\"}", got[1]);
    }
}

test "a tail without a final newline still counts as a record" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    for ([_]usize{ 3, 4096 }) |size| {
        const got = try collect(arena, "{\"a\":1}\n{\"b\":2}", size);
        try testing.expectEqual(@as(usize, 2), got.len);
        try testing.expectEqualStrings("{\"b\":2}", got[1]);
    }
}

test "blank lines are dropped, a CR before the LF is not part of the record" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();

    const got = try collect(arena_state.allocator(), "\r\n{\"a\":1}\r\n\n{\"b\":2}\n", 4096);
    try testing.expectEqual(@as(usize, 2), got.len);
    try testing.expectEqualStrings("{\"a\":1}", got[0]);
    try testing.expectEqualStrings("{\"b\":2}", got[1]);
}

test "u2028 and u2029 inside a string are not record boundaries" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();

    const record = "{\"text\":\"line\u{2028}separator\u{2029}\"}";
    const got = try collect(arena_state.allocator(), record ++ "\n", 4096);
    try testing.expectEqual(@as(usize, 1), got.len);
    try testing.expectEqualStrings(record, got[0]);
}

test "empty input yields no records" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();

    const got = try collect(arena_state.allocator(), "", 4096);
    try testing.expectEqual(@as(usize, 0), got.len);
}

test "the fixture stream frames into its own lines at every read size" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    for ([_]usize{ 1, 3, 64, 512, 4096, 1 << 20 }) |size| try expectLines(arena, stream, size);
}
