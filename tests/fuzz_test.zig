//! Random bytes through the two places piui trusts its input: the JSONL framer
//! and the record parser.
//!
//! `zig build test` replays a few thousand steps of the generator below, seeded
//! so a failure repeats. `zig build test -Dfuzz=200000` is the run to do before
//! a release; a finding becomes a test beside the others, never just a fixed
//! generator.

const std = @import("std");
const options = @import("options");
const Io = std.Io;
const testing = std.testing;
const piui = @import("piui");
const framing = piui.framing;
const protocol = piui.protocol;

const stream = @embedFile("../testdata/stream.jsonl");

const alphabet = [_][]const u8{
    "{",             "}",                    "[",                    "]",  ",",    ":",    "\"",    "\\",   " ",     "\t",   "\n",       "\r",
    "\u{2028}",      "\u{2029}",             "0",                    "1",  "9",    "t",    "n",     "u",    "e",     "type", "response", "agent_start",
    "agent_settled", "session_info_changed", "extension_ui_request", "id", "data", "name", "delta", "true", "false",
};

const seeds = [_][]const u8{
    "",
    "\n",
    "\n\n\n",
    "{}",
    "{\"type\":\"agent_start\"}",
    "{\"type\":\"agent_start\"}\n",
    "{\"type\":\"response\",\"id\":\"x\",\"command\":\"prompt\",\"success\":true}",
    "{\"text\":\"unterminated",
    "{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":1}}}}}}}}}}",
    "{\"type\":\"session_info_changed\",\"name\":\"" ++ "\u{1F600}" ++ "\"}",
    "\r\n{\"a\":1}",
};

fn corpus(allocator: std.mem.Allocator) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;

    var lines = std.mem.splitScalar(u8, stream, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        try out.append(allocator, line);
    }
    for (&seeds) |seed| try out.append(allocator, seed);
    return out.items;
}

fn text(allocator: std.mem.Allocator, random: std.Random, pieces: []const []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;

    const parts = random.uintLessThan(usize, 24) + 1;
    for (0..parts) |_| {
        switch (random.uintLessThan(u8, 10)) {
            0, 1, 2, 3, 4 => try out.appendSlice(allocator, pieces[random.uintLessThan(usize, pieces.len)]),
            5, 6 => try out.append(allocator, random.int(u8)),
            else => try out.appendSlice(allocator, alphabet[random.uintLessThan(usize, alphabet.len)]),
        }
    }

    // Half of the inputs end on a record boundary, the other half cut mid-line.
    if (random.boolean()) try out.appendSlice(allocator, "\n");
    return out.items;
}

fn reference(allocator: std.mem.Allocator, data: []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line| {
        const trimmed = if (line.len > 0 and line[line.len - 1] == '\r') line[0 .. line.len - 1] else line;
        if (trimmed.len == 0) continue;
        try out.append(allocator, trimmed);
    }
    return out.items;
}

fn step(allocator: std.mem.Allocator, data: []const u8, piece_size: usize) !void {
    var buffer: [256]u8 = undefined;
    var source = testing.Reader.init(&buffer, &.{.{ .buffer = data }});
    source.artificial_limit = .limited(piece_size);

    var records = framing.Records.init(allocator, &source.interface);
    defer records.deinit();

    const want = try reference(allocator, data);
    var seen: usize = 0;
    while (try records.next()) |record| {
        defer allocator.free(record);
        try testing.expectEqualStrings(want[seen], record);
        seen += 1;

        _ = protocol.parse(allocator, record) catch |err| switch (err) {
            error.InvalidRecord => {},
            error.OutOfMemory => return err,
        };

        if (seen == 1) {
            const before = std.json.parseFromSlice(std.json.Value, allocator, record, .{}) catch
                continue;
            defer before.deinit();
            const existing = if (before.value == .object)
                protocol.string(before.value.object, "id")
            else
                null;

            const stamped = protocol.ensureId(allocator, record, "piui-fuzz") catch |err| switch (err) {
                error.InvalidRecord => continue,
                else => return err,
            };
            defer allocator.free(stamped);

            var after = std.json.parseFromSlice(std.json.Value, allocator, stamped, .{}) catch
                return error.TestUnexpectedResult;
            defer after.deinit();

            const id = protocol.string(after.value.object, "id") orelse return error.TestUnexpectedResult;
            if (existing) |kept| {
                try testing.expectEqualStrings(kept, id);
            } else {
                try testing.expectEqualStrings("piui-fuzz", id);
            }
        }
    }
    try testing.expectEqual(want.len, seen);
}

test "framing and parsing survive random input" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const pieces = try corpus(arena);
    var generator = std.Random.Xoshiro256.init(0x70697569_66757a7a);
    var random = generator.random();

    const limit: usize = @intCast(options.fuzz_steps);
    for (0..limit) |round| {
        const data = try text(arena, random, pieces);
        const piece_size = 1 + random.uintLessThan(usize, 300);
        step(arena, data, piece_size) catch |err| {
            std.debug.print("\nround {d}, read size {d}\n--- input ---\n{s}\n", .{ round, piece_size, data });
            return err;
        };
        arena.free(data);
    }
}
