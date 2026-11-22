const std = @import("std");
const Io = std.Io;
const testing = std.testing;
const piui = @import("piui");
const sessions = piui.sessions;

const session_fixture = @embedFile("../testdata/session.jsonl");

const newer_session =
    \\{"type":"session","version":3,"id":"aaaaaaaa-0000-0000-0000-000000000000","timestamp":"2026-11-21T10:00:00.000Z","cwd":"/cache/projects/piui"}
    \\{"type":"message","id":"a1","parentId":null,"timestamp":"2026-11-21T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"add a sidebar"}],"timestamp":1763719201000}}
    \\{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-11-21T10:00:09.000Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"timestamp":1763719209000}}
    \\
;

const other_session =
    \\{"type":"session","version":3,"id":"bbbbbbbb-0000-0000-0000-000000000000","timestamp":"2026-11-19T08:00:00.000Z","cwd":"/tmp/other"}
    \\{"type":"message","id":"b1","parentId":null,"timestamp":"2026-11-19T08:00:01.000Z","message":{"role":"user","content":"unrelated project","timestamp":1763539201000}}
    \\
;

/// The store lives under the cache so a test run cannot touch a real Pi session, and each test gets
/// its own directory because the runner may run tests side by side.
fn build(comptime store: []const u8, io: Io) !void {
    const piui_dir = store ++ "/--cache-projects-piui--";
    const other_dir = store ++ "/--tmp-other--";

    Io.Dir.cwd().deleteTree(io, store) catch {};
    try Io.Dir.cwd().createDirPath(io, piui_dir);
    try Io.Dir.cwd().createDirPath(io, other_dir);

    try Io.Dir.cwd().writeFile(io, .{
        .sub_path = piui_dir ++ "/2026-11-20T09-12-33-123Z_6f2c1a90-9c0f-4d3e-9b1a-2c7f5d8e1a34.jsonl",
        .data = session_fixture,
    });
    try Io.Dir.cwd().writeFile(io, .{
        .sub_path = piui_dir ++ "/2026-11-21T10-00-00-000Z_aaaaaaaa.jsonl",
        .data = newer_session,
    });
    try Io.Dir.cwd().writeFile(io, .{
        .sub_path = other_dir ++ "/2026-11-19T08-00-00-000Z_bbbbbbbb.jsonl",
        .data = other_session,
    });

    try Io.Dir.cwd().writeFile(io, .{ .sub_path = other_dir ++ "/not-a-session.jsonl", .data = "{ not json\n" });
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = other_dir ++ "/notes.txt", .data = "ignored\n" });
}

test "list finds the sessions of one project, newest first" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try build(".zig-cache/piui-sessions-list", io);
    defer Io.Dir.cwd().deleteTree(io, ".zig-cache/piui-sessions-list") catch {};

    const index = sessions.Index.init(arena, io, ".zig-cache/piui-sessions-list");
    const found = try index.list("/cache/projects/piui");

    try testing.expectEqual(@as(usize, 2), found.len);
    try testing.expectEqualStrings("aaaaaaaa", found[0].id);
    try testing.expectEqualStrings("6f2c1a90-9c0f-4d3e-9b1a-2c7f5d8e1a34", found[1].id);

    const fixture = found[1];
    try testing.expectEqualStrings("Fix the red framing test", fixture.name.?);
    try testing.expectEqualStrings("/cache/projects/piui", fixture.cwd.?);
    try testing.expectEqualStrings("why is the framing test red?", fixture.first_text.?);
    try testing.expectEqual(@as(u32, 4), fixture.messages);
    try testing.expectEqualStrings("2026-11-20T09:12:33.123Z", fixture.created.?);
    try testing.expectEqualStrings("2026-11-20T09:13:01.000Z", fixture.updated.?);

    try testing.expectEqualStrings("add a sidebar", found[0].first_text.?);
    try testing.expect(found[0].name == null);
}

test "list without a project walks every directory and skips what it cannot read" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try build(".zig-cache/piui-sessions-all", io);
    defer Io.Dir.cwd().deleteTree(io, ".zig-cache/piui-sessions-all") catch {};

    const found = try sessions.Index.init(arena, io, ".zig-cache/piui-sessions-all").list(null);
    try testing.expectEqual(@as(usize, 3), found.len);
    try testing.expectEqualStrings("aaaaaaaa", found[0].id);
    try testing.expectEqualStrings("bbbbbbbb", found[2].id);
    try testing.expectEqualStrings("unrelated project", found[2].first_text.?);
}

test "a missing store lists nothing instead of failing" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();

    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();

    const found = try sessions.Index.init(arena_state.allocator(), threaded.io(), ".zig-cache/no-such-store")
        .list(null);
    try testing.expectEqual(@as(usize, 0), found.len);
}

test "a flat store, the way Pi writes today, is listed and resolvable" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const store = ".zig-cache/piui-sessions-flat";
    Io.Dir.cwd().deleteTree(io, store) catch {};
    try Io.Dir.cwd().createDirPath(io, store);
    defer Io.Dir.cwd().deleteTree(io, store) catch {};

    try Io.Dir.cwd().writeFile(io, .{ .sub_path = store ++ "/2026-11-21T10-00-00-000Z_aaaaaaaa.jsonl", .data = newer_session });
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = store ++ "/2026-11-19T08-00-00-000Z_bbbbbbbb.jsonl", .data = other_session });

    const index = sessions.Index.init(arena, io, store);

    const all = try index.list(null);
    try testing.expectEqual(@as(usize, 2), all.len);

    const one = try index.list("/cache/projects/piui");
    try testing.expectEqual(@as(usize, 1), one.len);
    try testing.expectEqualStrings("add a sidebar", one[0].first_text.?);

    const path = try index.resolve("bbbbbbbb");
    try testing.expect(std.mem.endsWith(u8, path, "2026-11-19T08-00-00-000Z_bbbbbbbb.jsonl"));
}

test "resolve finds a session by id in any project directory" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try build(".zig-cache/piui-sessions-resolve", io);
    defer Io.Dir.cwd().deleteTree(io, ".zig-cache/piui-sessions-resolve") catch {};

    const index = sessions.Index.init(arena, io, ".zig-cache/piui-sessions-resolve");
    const path = try index.resolve("bbbbbbbb");
    try testing.expect(std.mem.endsWith(u8, path, "2026-11-19T08-00-00-000Z_bbbbbbbb.jsonl"));

    try testing.expectError(error.NotFound, index.resolve("deadbeef"));
    try testing.expectError(error.NotFound, index.resolve(""));
    try testing.expectError(error.NotFound, index.resolve("../../etc/passwd"));
}

test "cwdOf names the project a session file belongs to" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try build(".zig-cache/piui-sessions-cwd", io);
    defer Io.Dir.cwd().deleteTree(io, ".zig-cache/piui-sessions-cwd") catch {};

    const index = sessions.Index.init(arena, io, ".zig-cache/piui-sessions-cwd");

    const path = try index.resolve("bbbbbbbb");
    try testing.expectEqualStrings("/tmp/other", index.cwdOf(path).?);

    try testing.expect(index.cwdOf(".zig-cache/piui-sessions-cwd/nope.jsonl") == null);
    try testing.expect(index.cwdOf(".zig-cache/piui-sessions-cwd") == null);
}
