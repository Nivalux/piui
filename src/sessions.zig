//! Read-only view of Pi's own session store.
//!
//! Pi keeps one JSONL file per session, named `<timestamp>_<id>.jsonl`. Older
//! builds filed them into a directory per project, current ones drop them
//! straight into the root - so piui scans the root *and* its subdirectories and
//! filters on the `cwd` of the header instead of rebuilding Pi's path encoding.
//! A change upstream then costs a scan, not a broken sidebar.

const std = @import("std");
const Io = std.Io;
const protocol = @import("protocol.zig");
const json = @import("json.zig");

pub const head_limit = 1 << 20;
pub const tail_limit = 8 * 1024;
/// How far back from the end of a session file to look for a line that finished.
const tail_scan_limit = 4 << 20;
pub const max_sessions = 300;
pub const title_limit = 160;

pub const Entry = struct {
    id: []const u8,
    path: []const u8,
    name: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    created: ?[]const u8 = null,
    updated: ?[]const u8 = null,
    first_text: ?[]const u8 = null,
    messages: u32 = 0,
    running: bool = false,
};

pub const Index = struct {
    allocator: std.mem.Allocator,
    io: Io,
    root: []const u8,

    pub fn init(allocator: std.mem.Allocator, io: Io, root: []const u8) Index {
        return .{ .allocator = allocator, .io = io, .root = root };
    }

    /// Every session of one project, newest first. `cwd` of `null` lists all.
    pub fn list(self: Index, cwd: ?[]const u8) ![]Entry {
        var found: std.ArrayList(Entry) = .empty;
        errdefer found.deinit(self.allocator);

        const dirs = try self.directories();
        for (dirs) |directory| {
            var dir = Io.Dir.cwd().openDir(self.io, directory, .{ .iterate = true }) catch continue;
            defer dir.close(self.io);

            var iterator = dir.iterate();
            while (iterator.next(self.io) catch null) |item| {
                if (item.kind != .file) continue;
                if (!std.mem.endsWith(u8, item.name, ".jsonl")) continue;

                const path = std.fs.path.join(self.allocator, &.{ directory, item.name }) catch continue;
                const entry = self.readHead(path) catch continue;
                if (cwd) |want| {
                    const have = entry.cwd orelse continue;
                    if (!std.mem.eql(u8, have, want)) continue;
                }
                found.append(self.allocator, entry) catch return error.OutOfMemory;
                if (found.items.len >= max_sessions) break;
            }
        }

        std.sort.block(Entry, found.items, {}, newer);
        return found.items;
    }

    /// The project a session file was started in. Pi writes it in the header,
    /// so resuming a chat can put it back where it belongs instead of in a
    /// scratch folder it has nothing to do with.
    pub fn cwdOf(self: Index, path: []const u8) ?[]const u8 {
        const entry = self.readHead(path) catch return null;
        return entry.cwd;
    }

    /// Path of the file that stores `id`, searched in every project directory.
    pub fn resolve(self: Index, id: []const u8) ![]u8 {
        if (id.len == 0 or std.mem.indexOfScalar(u8, id, '/') != null) return error.NotFound;

        const dirs = try self.directories();
        for (dirs) |directory| {
            var dir = Io.Dir.cwd().openDir(self.io, directory, .{ .iterate = true }) catch continue;
            defer dir.close(self.io);

            var iterator = dir.iterate();
            while (iterator.next(self.io) catch null) |item| {
                if (item.kind != .file) continue;
                if (!std.mem.eql(u8, sessionId(item.name), id)) continue;
                return std.fs.path.join(self.allocator, &.{ directory, item.name });
            }
        }
        return error.NotFound;
    }

    /// The root plus every directory under it: Pi has moved this layout before
    /// and the scan has to survive the next move.
    fn directories(self: Index) ![]const []const u8 {
        var out: std.ArrayList([]const u8) = .empty;
        out.append(self.allocator, self.root) catch return error.OutOfMemory;

        var dir = Io.Dir.cwd().openDir(self.io, self.root, .{ .iterate = true }) catch return out.items;
        defer dir.close(self.io);

        var iterator = dir.iterate();
        while (iterator.next(self.io) catch null) |item| {
            if (item.kind != .directory) continue;
            out.append(
                self.allocator,
                std.fs.path.join(self.allocator, &.{ self.root, item.name }) catch continue,
            ) catch return error.OutOfMemory;
        }
        return out.items;
    }

    fn readHead(self: Index, path: []const u8) !Entry {
        const head = try self.readHeadRaw(path);
        defer self.allocator.free(head);

        var entry = Entry{ .id = sessionId(path), .path = path };
        var lines = std.mem.splitScalar(u8, head, '\n');
        var stamp: ?[]const u8 = null;
        while (lines.next()) |line| {
            if (line.len == 0) continue;
            var parsed = std.json.parseFromSlice(std.json.Value, self.allocator, line, .{}) catch continue;
            defer parsed.deinit();
            if (parsed.value != .object) continue;

            const object = parsed.value.object;
            const kind = protocol.string(object, "type") orelse continue;

            if (std.mem.eql(u8, kind, "session")) {
                entry.cwd = own(self.allocator, protocol.string(object, "cwd"));
                entry.created = own(self.allocator, protocol.string(object, "timestamp"));
            } else if (std.mem.eql(u8, kind, "session_info")) {
                entry.name = own(self.allocator, protocol.string(object, "name"));
            } else if (std.mem.eql(u8, kind, "message")) {
                entry.messages += 1;
                if (entry.first_text == null) entry.first_text = userText(self.allocator, object);
            }

            if (protocol.string(object, "timestamp")) |seen| stamp = seen;
        }

        // A file that never carried a `session` header is not a session, however
        // well the lines around it parsed.
        if (entry.created == null and entry.cwd == null) return error.NotASession;

        entry.updated = self.tailStamp(path) orelse (if (stamp) |seen| own(self.allocator, seen) else null);
        return entry;
    }

    /// The `timestamp` of the last line of a file, which is the activity the
    /// sidebar sorts on. A session longer than the head read has its newest line
    /// far behind it, so the end gets its own look.
    ///
    /// One answer can append a line far bigger than a window - a file read whole,
    /// a tool result with a trace in it - and while that line is still going in,
    /// nothing in the last window parses. Stepping back a window at a time is
    /// what keeps the sidebar showing the last thing that finished rather than
    /// falling back on a header from the start of the chat, which is how a row
    /// used to lose its time and its place in the list until the next line landed.
    fn tailStamp(self: Index, path: []const u8) ?[]const u8 {
        var file = Io.Dir.cwd().openFile(self.io, path, .{}) catch return null;
        defer file.close(self.io);

        const info = file.stat(self.io) catch return null;
        if (info.size <= head_limit) return null;

        const size: usize = @intCast(info.size);
        var buffer: [tail_limit]u8 = undefined;
        var back: usize = 0;
        while (back < size and back <= tail_scan_limit) {
            const length: usize = @min(tail_limit, size - back);
            const read = file.readPositionalAll(self.io, buffer[0..length], size - back - length) catch return null;
            // A fragment at either edge belongs to a line that began or ends
            // outside the window. It will not parse, so it costs nothing.
            if (lastTimestamp(self.allocator, buffer[0..read])) |stamp| return stamp;
            back += length;
        }
        return null;
    }

    fn readHeadRaw(self: Index, path: []const u8) ![]u8 {
        var buffer: [16 * 1024]u8 = undefined;
        var file = Io.Dir.cwd().openFile(self.io, path, .{}) catch return error.NotFound;
        defer file.close(self.io);

        var stream = file.readerStreaming(self.io, &buffer);
        var head: std.ArrayList(u8) = .empty;
        errdefer head.deinit(self.allocator);

        var chunk: [8 * 1024]u8 = undefined;
        while (head.items.len < head_limit) {
            const read = stream.interface.readSliceShort(&chunk) catch break;
            if (read == 0) break;
            head.appendSlice(self.allocator, chunk[0..read]) catch return error.OutOfMemory;
        }
        return head.toOwnedSlice(self.allocator);
    }
};

/// The text of the first user message, which is what the sidebar shows when a
/// session has no explicit name.
fn userText(allocator: std.mem.Allocator, object: std.json.ObjectMap) ?[]const u8 {
    const message = protocol.get(object, "message") orelse return null;
    if (message != .object) return null;
    if (!std.mem.eql(u8, protocol.string(message.object, "role") orelse "", "user")) return null;

    const content = protocol.get(message.object, "content") orelse return null;
    switch (content) {
        .string => |text| return clip(allocator, text),
        .array => |items| {
            for (items.items) |item| {
                if (item != .object) continue;
                if (!std.mem.eql(u8, protocol.string(item.object, "type") orelse "", "text")) continue;
                if (protocol.string(item.object, "text")) |text| return clip(allocator, text);
            }
        },
        else => {},
    }
    return null;
}

fn clip(allocator: std.mem.Allocator, text: []const u8) ?[]const u8 {
    const trimmed = std.mem.trim(u8, text, " \t\r\n");
    if (trimmed.len == 0) return null;
    if (trimmed.len <= title_limit) return allocator.dupe(u8, trimmed) catch null;

    var end: usize = title_limit;
    while (end > 0 and (trimmed[end] & 0xc0) == 0x80) end -= 1;
    return allocator.dupe(u8, trimmed[0..end]) catch null;
}

fn own(allocator: std.mem.Allocator, value: ?[]const u8) ?[]const u8 {
    const text = value orelse return null;
    return allocator.dupe(u8, text) catch null;
}

/// `<timestamp>_<id>.jsonl` → `<id>`; Pi also accepts a bare `<id>.jsonl`.
pub fn sessionId(file_name: []const u8) []const u8 {
    var base = std.fs.path.basename(file_name);
    if (std.mem.endsWith(u8, base, ".jsonl")) base = base[0 .. base.len - ".jsonl".len];
    if (std.mem.lastIndexOfScalar(u8, base, '_')) |cut| return base[cut + 1 ..];
    return base;
}

/// The `timestamp` of the last parseable line, copied out so it outlives the
/// window it was read from.
fn lastTimestamp(allocator: std.mem.Allocator, raw: []const u8) ?[]const u8 {
    var found: ?[]const u8 = null;
    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var parsed = std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch continue;
        defer parsed.deinit();
        if (parsed.value != .object) continue;
        if (protocol.string(parsed.value.object, "timestamp")) |seen| found = seen;
    }
    return if (found) |text| own(allocator, text) else null;
}

/// Newest activity first. Two sessions touched in the same millisecond are
/// ordered by id, because a sort that leaves a tie to whatever the folder
/// iterator happened to return makes the sidebar reshuffle on every poll.
fn newer(_: void, a: Entry, b: Entry) bool {
    const left = a.updated orelse a.created orelse "";
    const right = b.updated orelse b.created orelse "";
    return switch (std.mem.order(u8, left, right)) {
        .gt => true,
        .lt => false,
        .eq => std.mem.order(u8, a.id, b.id) == .gt,
    };
}

test "sessions with the same stamp keep one order" {
    const entries = [_]Entry{
        .{ .id = "a", .path = "a", .updated = "2026-11-20T10:00:00.000Z" },
        .{ .id = "b", .path = "b", .updated = null, .created = null },
        .{ .id = "c", .path = "c", .updated = "2026-11-20T10:00:00.000Z" },
    };

    var list = std.mem.cloneAllocator(std.testing.allocator, &entries);
    defer std.testing.allocator.free(&list);
    std.sort.block(Entry, &list, {}, newer);

    try std.testing.expectEqualStrings("c", list[0].id);
    try std.testing.expectEqualStrings("a", list[1].id);
    try std.testing.expectEqualStrings("b", list[2].id, "one that never carried a timestamp is the oldest thing here");
}

test "lastTimestamp takes the newest line, not the first" {
    const raw =
        "{\"type\":\"session\",\"cwd\":\"/srv/app\",\"timestamp\":\"2026-11-20T09:00:00.000Z\"}\n" ++
        "{\"type\":\"message\",\"timestamp\":\"2026-11-20T09:01:00.000Z\"}\n" ++
        "truncated mid line {\"timestamp\":\"2026-11-20T09:02\"\n" ++
        "{\"type\":\"message\",\"timestamp\":\"2026-11-20T18:30:00.000Z\"}\n";

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const found = lastTimestamp(arena.allocator(), raw) orelse return error.TestUnexpectedResult;
    try std.testing.equalStrings("2026-11-20T18:30:00.000Z", found);
}

test "a session still writing its last line keeps the stamp before it" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const io = std.testing.io;

    var store = std.testing.tmpDir(.{});
    defer store.cleanup(io);

    var body: std.ArrayList(u8) = .empty;
    try body.appendSlice(a, "{\"type\":\"session\",\"cwd\":\"/srv/app\",\"timestamp\":\"2026-11-20T09:00:00.000Z\"}\n");

    // One line longer than the head read, so the end of the file is all the
    // sidebar has to go on.
    try body.appendSlice(a, "{\"type\":\"message\",\"timestamp\":\"2026-11-20T10:00:00.000Z\",\"text\":\"");
    while (body.items.len <= head_limit) try body.append(a, 'x');
    try body.appendSlice(a, "\"}\n");

    try body.appendSlice(a, "{\"type\":\"message\",\"timestamp\":\"2026-11-20T18:30:00.000Z\"}\n");

    // And a line still going in, bigger than one window, so no window at the end
    // of the file holds a line that ends.
    try body.appendSlice(a, "{\"type\":\"message\",\"timestamp\":\"2026-11-20T19:00:00.000Z\",\"text\":\"");
    var trailing: usize = 0;
    while (trailing < tail_limit * 2) : (trailing += 1) try body.append(a, 'y');

    try store.dir.writeFile(io, .{ .sub_path = "s.jsonl", .data = body.items });
    var buffer: [4096]u8 = undefined;
    const directory = store.dir.realPath(io, &buffer) catch return error.SkipZigTest;

    var index = Index.init(a, io, directory);
    const entry = try index.readHead(std.fs.path.join(a, &.{ directory, "s.jsonl" }));
    try std.testing.equalStrings("2026-11-20T18:30:00.000Z", entry.updated);
}

test "sessionId strips the timestamp prefix" {
    try std.testing.equalStrings(
        "6f2c1a90-9c0f-4d3e-9b1a-2c7f5d8e1a34",
        sessionId("2026-11-20T09-12-33-123Z_6f2c1a90-9c0f-4d3e-9b1a-2c7f5d8e1a34.jsonl"),
    );
    try std.testing.equalStrings("abc", sessionId("abc.jsonl"));
    try std.testing.equalStrings("abc", sessionId("dir/abc.jsonl"));
}
