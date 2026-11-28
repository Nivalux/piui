const std = @import("std");
const Io = std.Io;
const testing = std.testing;
const piui = @import("piui");
const hub = piui.hub;

const gone_chat =
    \\{"type":"session","version":3,"id":"cccccccc-0000-0000-0000-000000000000","timestamp":"2026-11-03T00:00:00.000Z","cwd":"/tmp/gone-project"}
    \\{"type":"message","id":"c1","parentId":null,"timestamp":"2026-11-03T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"a chat whose home is gone"}]}}
    \\{"type":"message","id":"c2","parentId":"c1","timestamp":"2026-11-03T00:00:09.000Z","message":{"role":"assistant","content":[{"type":"text","text":"here is what was saved"}]}}
    \\
;

fn opened(comptime dir: []const u8, io: Io, a: std.mem.Allocator) !hub.Hub {
    try Io.Dir.cwd().createDirPath(io, dir ++ "/store");
    try Io.Dir.cwd().createDirPath(io, dir ++ "/scratch");
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = dir ++ "/store/gone.jsonl", .data = gone_chat });

    return .{
        .allocator = a,
        .io = io,
        .group = undefined,
        .pi_bin = "pi",
        .scratch_root = dir ++ "/scratch",
        .sessions_root = dir ++ "/store",
        .idle_after_ms = 60_000,
    };
}

test "idle reclamation preserves tabs and only manual close removes saved entries" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var h = try opened("tmp/hub-idle", io, arena.allocator());
    defer Io.Dir.cwd().deleteTree(io, "tmp/hub-idle") catch {};
    h.state_path = "tmp/hub-idle/tabs.json";
    h.idle_after_ms = 1;
    var first = hub.Tab{ .id = "t1", .cwd = "/tmp", .project = true, .session_path = "/tmp/first.jsonl", .created_ms = 0, .last_output_ms = -1000000 };
    var second = hub.Tab{ .id = "t2", .cwd = "/tmp", .project = true, .session_path = "/tmp/second.jsonl", .created_ms = 0, .last_output_ms = -1000000 };
    try h.tabs.put(arena.allocator(), first.id, &first);
    try h.tabs.put(arena.allocator(), second.id, &second);
    h.reapIdle();
    try testing.expect(h.get(first.id) == &first);
    try testing.expect(h.get(second.id) == &second);
    try testing.expect(!first.closed and !second.closed);
    first.closed = true;
    h.close(&second, "closed by user");
    try testing.expect(h.get(second.id) == null);
    const saved = hub.Hub.loadSaved(arena.allocator(), io, h.state_path);
    try testing.expectEqual(@as(usize, 1), saved.len);
    try testing.expectEqualStrings("/tmp/first.jsonl", saved[0].session.?);
}

test "a pi marked for a restart goes between turns, never during one" {
    try testing.expect(hub.readyToReplace(true, false, false, false, 0, false, 0));
    try testing.expect(hub.readyToReplace(true, false, false, false, 3, true, 0));
    try testing.expect(!hub.readyToReplace(true, true, false, false, 0, false, 0));
    try testing.expect(!hub.readyToReplace(true, true, false, false, 0, true, 0));
    try testing.expect(!hub.readyToReplace(true, false, true, false, 0, true, 0));
    try testing.expect(!hub.readyToReplace(true, false, false, true, 0, true, 0));
    try testing.expect(!hub.readyToReplace(false, false, false, false, 0, true, 0));
    try testing.expect(!hub.readyToReplace(true, false, false, false, 0, true, 1));
}

test "a thought is only steered into a turn that still collects steering" {
    try testing.expect(hub.stillSteering(true, false));
    try testing.expect(!hub.stillSteering(true, true));
    try testing.expect(!hub.stillSteering(false, false));
}

test "a tab that lands on another session file is remembered again" {
    try testing.expect(hub.sessionMoved(null, "/store/fork.jsonl"));
    try testing.expect(hub.sessionMoved("/store/parent.jsonl", "/store/fork.jsonl"));
    try testing.expect(!hub.sessionMoved("/store/fork.jsonl", "/store/fork.jsonl"));
}

test "the copy keeps every line and moves only the folder" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    var group: Io.Group = .init;
    var h = try opened("tmp/hub-copy", io, arena.allocator());
    h.group = &group;
    defer Io.Dir.cwd().deleteTree(io, "tmp/hub-copy") catch {};

    const copy = try h.copyForRead("tmp/hub-copy/store/gone.jsonl");

    const body = try Io.Dir.cwd().readFileAlloc(io, copy.path, arena.allocator(), .unlimited);

    var lines = std.mem.splitScalar(u8, std.mem.trim(u8, body, "\n"), '\n');
    const header = lines.first();
    try testing.expect(std.mem.indexOf(u8, header, "/tmp/gone-project") == null);
    try testing.expect(std.mem.indexOf(u8, header, copy.dir) != null);

    const first = lines.next() orelse return error.TestUnexpectedResult;
    try testing.expectEqualStrings(
        \\{"type":"message","id":"c1","parentId":null,"timestamp":"2026-11-03T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"a chat whose home is gone"}]}}
    , first);

    const second = lines.next() orelse return error.TestUnexpectedResult;
    try testing.expect(std.mem.indexOf(u8, second, "here is what was saved") != null);
    try testing.expect(lines.next() == null);

    const kept = try Io.Dir.cwd().readFileAlloc(io, "tmp/hub-copy/store/gone.jsonl", arena.allocator(), .unlimited);
    try testing.expectEqualStrings(gone_chat, kept);
}

test "cleaning up empties the folders piui minted and keeps the root itself" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var h = try opened("tmp/hub-sweep", io, arena.allocator());
    defer Io.Dir.cwd().deleteTree(io, "tmp/hub-sweep") catch {};

    try Io.Dir.cwd().createDirPath(io, "tmp/hub-sweep/scratch/one/inner");
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = "tmp/hub-sweep/scratch/one/photo.jpg", .data = "picture" });
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = "tmp/hub-sweep/scratch/loose.txt", .data = "loose" });

    try testing.expectEqual(@as(usize, 2), h.clearScratch());
    try Io.Dir.access(.cwd(), io, "tmp/hub-sweep/scratch", .{});

    var dir = try Io.Dir.cwd().openDir(io, "tmp/hub-sweep/scratch", .{ .iterate = true });
    defer dir.close(io);
    var walker = dir.iterate();
    try testing.expectEqual(@as(?Io.Dir.Entry, null), try walker.next(io));
}

fn sessionAt(io: Io, comptime path: []const u8, comptime cwd: []const u8) !void {
    try Io.Dir.cwd().createDirPath(io, std.fs.path.dirname(path) orelse ".");
    try Io.Dir.cwd().writeFile(io, .{
        .sub_path = path,
        .data = "{\"type\":\"session\",\"cwd\":\"" ++ cwd ++ "\",\"timestamp\":\"2026-11-28T00:00:00.000Z\"}\n",
    });
}

test "cleaning up drops the chats pi kept for the folders it minted" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var h = try opened("tmp/hub-sweep-sessions", io, arena.allocator());
    defer Io.Dir.cwd().deleteTree(io, "tmp/hub-sweep-sessions") catch {};

    try sessionAt(io, "tmp/hub-sweep-sessions/store/--minted--/one.jsonl", "tmp/hub-sweep-sessions/scratch/99-1");
    try sessionAt(io, "tmp/hub-sweep-sessions/store/project/two.jsonl", "/tmp/some-project");

    try testing.expectEqual(@as(usize, 1), h.clearScratchSessions());
    try testing.expectError(
        error.FileNotFound,
        Io.Dir.access(.cwd(), io, "tmp/hub-sweep-sessions/store/--minted--", .{}),
    );
    try Io.Dir.access(.cwd(), io, "tmp/hub-sweep-sessions/store/project/two.jsonl", .{});
    try Io.Dir.access(.cwd(), io, "tmp/hub-sweep-sessions/store/gone.jsonl", .{});
}

test "a chat that named its throw-away folder relatively is dropped too" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var h = try opened("tmp/hub-sweep-relative", io, arena.allocator());
    defer Io.Dir.cwd().deleteTree(io, "tmp/hub-sweep-relative") catch {};

    h.scratch_root = "tmp/hub-sweep-relative/.piui/scratch";
    h.home = "tmp/hub-sweep-relative";
    h.here = "tmp/hub-sweep-relative";
    try sessionAt(io, "tmp/hub-sweep-relative/store/--tilde--/one.jsonl", "~/.piui/scratch/99-1");

    try testing.expectEqual(@as(usize, 1), h.clearScratchSessions());
    try testing.expectError(
        error.FileNotFound,
        Io.Dir.access(.cwd(), io, "tmp/hub-sweep-relative/store/--tilde--", .{}),
    );
}
