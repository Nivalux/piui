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
