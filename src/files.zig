const std = @import("std");
const Io = std.Io;

/// One screen of a file. More than this and the browser would build a wall of text nobody scrolls;
/// the rest is reported as truncated.
pub const max_read_bytes = 512 * 1024;
pub const max_list = 4000;

const max_depth = 12;

/// Folders that are machine-made and never interesting to read. Dot folders are skipped on their
/// own, so `.git` and `.zig-cache` need no mention here.
const skip = [_][]const u8{ "node_modules", "zig-cache", "zig-out", "__pycache__", "target", "dist" };

pub const Error = std.mem.Allocator.Error || error{ NotFound, NotFile, Outside };

pub const Entry = struct {
    path: []const u8,
};

pub const Listing = struct {
    root: []const u8,
    files: []const Entry,
    truncated: bool,
};

pub const Content = struct {
    path: []const u8,
    text: []const u8,
    size: usize,
    truncated: bool,
    binary: bool,
};

/// Every readable file under `root`, relative to it and sorted, capped at `cap`. A folder that
/// cannot be opened is passed over: a project full of sockets and mount points still lists what is
/// readable in it.
pub fn list(a: std.mem.Allocator, io: Io, root: []const u8, cap: usize) !Listing {
    if (root.len == 0 or root[0] != '/') return error.NotFound;

    var dir = Io.Dir.cwd().openDir(io, root, .{ .iterate = true }) catch return error.NotFound;
    defer dir.close(io);

    var found: std.ArrayListUnmanaged(Entry) = .empty;
    errdefer found.deinit(a);
    var truncated = false;

    walk(a, io, dir, "", 0, cap, &found, &truncated);
    std.sort.block(Entry, found.items, {}, earlier);
    return .{ .root = root, .files = found.items, .truncated = truncated };
}

fn walk(
    a: std.mem.Allocator,
    io: Io,
    dir: Io.Dir,
    prefix: []const u8,
    depth: usize,
    cap: usize,
    found: *std.ArrayListUnmanaged(Entry),
    truncated: *bool,
) void {
    if (depth >= max_depth) return;

    var iterator = dir.iterate();
    while (!truncated.*) {
        const item = iterator.next(io) catch break;
        const item_ = item orelse break;
        const name = item_.name;
        if (name.len == 0 or name[0] == '.' or skipped(name)) continue;
        if (item_.kind == .sym_link) continue;

        const path = if (prefix.len == 0)
            a.dupe(u8, name) catch return
        else
            std.mem.join(a, "/", &.{ prefix, name }) catch return;

        if (isDirectory(dir, io, name, item_.kind)) {
            var sub = dir.openDir(io, name, .{ .iterate = true }) catch continue;
            defer sub.close(io);
            walk(a, io, sub, path, depth + 1, cap, found, truncated);
            continue;
        }

        if (!isPlainFile(dir, io, name, item_.kind)) continue;
        if (found.items.len >= cap) {
            truncated.* = true;
            return;
        }
        found.append(a, .{ .path = path }) catch {
            truncated.* = true;
            return;
        };
    }
}

/// The contents of one file inside `root`. `path` is relative to it; an absolute path is accepted
/// only when it lands inside anyway.
pub fn read(a: std.mem.Allocator, io: Io, root: []const u8, requested: []const u8) !Content {
    const path = try inside(a, root, requested);

    var buffer: [8 * 1024]u8 = undefined;
    var file = Io.Dir.cwd().openFile(io, path, .{ .allow_directory = false }) catch |err| return switch (err) {
        error.IsDir => error.NotFile,
        else => error.NotFound,
    };
    defer file.close(io);

    var reader = file.readerStreaming(io, &buffer);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(a);

    var truncated = false;
    var chunk: [8 * 1024]u8 = undefined;
    while (true) {
        const got = reader.interface.readSliceShort(&chunk) catch break;
        if (got == 0) break;
        if (out.items.len + got > max_read_bytes) {
            const room = max_read_bytes - out.items.len;
            out.appendSlice(a, chunk[0..room]) catch break;
            truncated = true;
            break;
        }
        out.appendSlice(a, chunk[0..got]) catch break;
    }

    var text = out.items;
    if (truncated and !std.unicode.utf8ValidateSlice(text)) {
        var back: usize = 1;
        while (back <= 4 and back <= text.len) : (back += 1) {
            if (std.unicode.utf8ValidateSlice(text[0 .. text.len - back])) {
                text = text[0 .. text.len - back];
                break;
            }
        }
    }

    const binary = std.mem.indexOfScalar(u8, text, 0) != null or !std.unicode.utf8ValidateSlice(text);
    return .{
        .path = path,
        .text = if (binary) "" else text,
        .size = out.items.len,
        .truncated = truncated,
        .binary = binary,
    };
}

/// `root` + `requested`, cleaned, and still under `root`.
fn inside(a: std.mem.Allocator, root: []const u8, requested: []const u8) ![]const u8 {
    if (requested.len == 0 or root.len == 0 or root[0] != '/') return error.NotFound;

    const joined = if (requested[0] == '/')
        try std.mem.concat(a, u8, &.{ "/", requested })
    else
        try std.mem.concat(a, u8, &.{ root, "/", requested });
    const path = try @import("dirs.zig").clean(a, joined);

    if (path.len <= root.len or !std.mem.startsWith(u8, path, root)) return error.Outside;
    if (path[root.len] != '/') return error.Outside;
    return path;
}

fn skipped(name: []const u8) bool {
    for (skip) |blocked| {
        if (std.mem.eql(u8, name, blocked)) return true;
    }
    return false;
}

fn isDirectory(dir: Io.Dir, io: Io, name: []const u8, kind: Io.File.Kind) bool {
    if (kind == .directory) return true;
    if (kind != .unknown) return false;
    const stat = dir.statFile(io, name, .{}) catch return false;
    return stat.kind == .directory;
}

fn isPlainFile(dir: Io.Dir, io: Io, name: []const u8, kind: Io.File.Kind) bool {
    if (kind == .file) return true;
    if (kind != .unknown) return false;
    const stat = dir.statFile(io, name, .{}) catch return false;
    return stat.kind == .file;
}

fn earlier(_: void, left: Entry, right: Entry) bool {
    return std.mem.order(u8, left.path, right.path) == .lt;
}
