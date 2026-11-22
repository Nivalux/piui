const std = @import("std");
const Io = std.Io;

pub const limit = 200;

pub const Entry = struct {
    name: []const u8,
    path: []const u8,
};

pub const Listing = struct {
    path: []const u8,
    parent: ?[]const u8,
    dirs: []const Entry,
};

pub const Error = std.mem.Allocator.Error || error{ NotFound, NotDirectory };

/// Where piui was started, which is the path a picker opens with.
pub fn current(a: std.mem.Allocator, io: Io) ![]const u8 {
    var buffer: [4096]u8 = undefined;
    const length = std.process.currentPath(io, &buffer) catch return error.NotFound;
    return clean(a, buffer[0..length]);
}

/// `//a/./b/../c/` becomes `/a/c`. String work only, so it holds without a disk.
pub fn clean(a: std.mem.Allocator, path: []const u8) ![]const u8 {
    var parts: std.ArrayList([]const u8) = .empty;
    defer parts.deinit(a);

    const rooted = path.len > 0 and path[0] == '/';
    var iterator = std.mem.tokenizeAny(u8, path, "/");
    while (iterator.next()) |part| {
        if (std.mem.eql(u8, part, ".")) continue;
        if (std.mem.eql(u8, part, "..")) {
            if (parts.items.len > 0) _ = parts.pop();
            continue;
        }
        try parts.append(a, part);
    }

    if (parts.items.len == 0) return a.dupe(u8, if (rooted) "/" else ".");
    const joined = try std.mem.join(a, "/", parts.items);
    defer a.free(joined);
    return if (rooted) std.mem.concat(a, u8, &.{ "/", joined }) else a.dupe(u8, joined);
}

/// The directories directly under `requested`, alphabetically; `null` asks for the folder piui runs
/// in.
pub fn list(a: std.mem.Allocator, io: Io, requested: ?[]const u8, cap: usize) !Listing {
    const path = if (requested) |want| try clean(a, want) else try current(a, io);
    if (path.len == 0 or path[0] != '/') return error.NotFound;

    var dir = Io.Dir.cwd().openDir(io, path, .{ .iterate = true }) catch |err| return switch (err) {
        error.NotDir => error.NotDirectory,
        else => error.NotFound,
    };
    defer dir.close(io);

    var found: std.ArrayListUnmanaged(Entry) = .empty;
    errdefer found.deinit(a);

    var iterator = dir.iterate();
    while (found.items.len < cap) {
        const item = iterator.next(io) catch break;
        if (item == null) break;
        const name = item.?.name;
        if (name.len == 0 or name[0] == '.') continue;
        if (!isDirectory(dir, io, name, item.?.kind)) continue;

        const full = if (std.mem.eql(u8, path, "/"))
            try std.mem.concat(a, u8, &.{ "/", name })
        else
            try std.mem.join(a, "/", &.{ path, name });
        found.append(a, .{ .name = try a.dupe(u8, name), .path = full }) catch {
            a.free(full);
            break;
        };
    }

    std.sort.block(Entry, found.items, {}, earlier);
    return .{ .path = path, .parent = std.fs.path.dirname(path), .dirs = found.items };
}

fn isDirectory(dir: Io.Dir, io: Io, name: []const u8, kind: Io.File.Kind) bool {
    if (kind == .directory) return true;
    if (kind != .unknown and kind != .sym_link) return false;
    const stat = dir.statFile(io, name, .{}) catch return false;
    return stat.kind == .directory;
}

fn earlier(_: void, left: Entry, right: Entry) bool {
    return std.ascii.orderIgnoreCase(left.name, right.name) == .lt;
}

test "a path is cleaned without a filesystem" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try std.testing.expectEqualStrings("/a/c", try clean(a, "/a/./b/../c/"));
    try std.testing.expectEqualStrings("/", try clean(a, "/a/.."));
    try std.testing.expectEqualStrings("/", try clean(a, "//"));
    try std.testing.expectEqualStrings("/a", try clean(a, "/a/../../a"));
    try std.testing.expectEqualStrings("a/b", try clean(a, "a//b/."));
}

test "a listing names the folders and the way back" {
    var threaded: Io.Threaded = .init(std.testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io;

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var root = std.testing.tmpDir(.{});
    defer root.cleanup(io);
    try root.dir.createDirPath(io, "beta");
    try root.dir.createDirPath(io, "Alpha");
    try root.dir.createDirPath(io, ".hidden");
    try root.dir.createDirPath(io, "beta/inner");
    try root.dir.writeFile(io, .{ .sub_path = "note.txt", .data = "x" });

    var buffer: [4096]u8 = undefined;
    const length = root.dir.realPath(io, &buffer) catch return error.SkipZigTest;

    const listing = try list(a, io, buffer[0..length], 10);
    try std.testing.expect(listing.path.len > 0);
    try std.testing.expect(listing.parent != null);
    try std.testing.expectEqual(@as(usize, 2), listing.dirs.len);
    try std.testing.expectEqualStrings("Alpha", listing.dirs[0].name);
    try std.testing.expectEqualStrings("beta", listing.dirs[1].name);
    try std.testing.expect(std.mem.endsWith(u8, listing.dirs[1].path, "/beta"));

    const missing = list(a, io, "/no/such/anywhere", 10);
    try std.testing.expectError(error.NotFound, missing);
}
