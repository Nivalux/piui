const std = @import("std");
const Io = std.Io;
const protocol = @import("protocol.zig");

pub const default_base = "working";
pub const default_host = "127.0.0.1";
pub const default_port = 7788;
pub const default_idle_seconds = 30 * 60;

/// What the process needs before it listens.
pub const Server = struct {
    host: []const u8 = default_host,
    port: u16 = default_port,
    pi: []const u8 = "pi",
    /// Pi's session store; empty means `~/.pi/agent/sessions`.
    sessions: []const u8 = "",
    /// Workdirs for chats without a project; empty means `~/.piui/scratch`.
    scratch: []const u8 = "",
    /// Close a tab whose pi has been idle this long; 0 keeps it forever.
    idle_seconds: i64 = default_idle_seconds,
};

/// The browser's own state, kept server-side so any window opens the way the last one was left.
pub const Ui = struct {
    theme: []const u8 = "dark",
    sidebar: bool = true,
    files: bool = true,
    sidebar_width: u16 = 264,
    files_width: u16 = 340,
    show_thinking: bool = false,
    send_on_enter: bool = true,
    /// "steer" interrupts the running turn, "queue" waits for it to settle.
    send_mode: []const u8 = "steer",
};

pub const Error = error{ WriteFailed, BadValue, OutOfMemory };

pub const Settings = struct {
    allocator: std.mem.Allocator,
    io: Io,
    path: []const u8,
    lock: Io.Mutex = .init,
    server: Server = .{},
    ui: Ui = .{},
    bases: std.StringHashMapUnmanaged([]const u8) = .empty,

    pub fn load(allocator: std.mem.Allocator, io: Io, path: []const u8) !*Settings {
        const self = try allocator.create(Settings);
        self.* = .{
            .allocator = allocator,
            .io = io,
            .path = path,
            .bases = .empty,
        };
        self.read();
        return self;
    }

    fn read(self: *Settings) void {
        const raw = readFile(self.allocator, self.io, self.path) catch return;
        defer self.allocator.free(raw);

        var parsed = std.json.parseFromSlice(std.json.Value, self.allocator, raw, .{}) catch return;
        defer parsed.deinit();
        if (parsed.value != .object) return;

        if (protocol.get(parsed.value.object, "server")) |value| {
            if (value == .object) {
                const piece = std.json.parseFromValue(Server, self.allocator, value, .{
                    .ignore_unknown_fields = true,
                    .duplicate_field_behavior = .use_last,
                }) catch return;
                self.server = piece.value;
            }
        }

        if (protocol.get(parsed.value.object, "ui")) |value| {
            if (value == .object) {
                const piece = std.json.parseFromValue(Ui, self.allocator, value, .{
                    .ignore_unknown_fields = true,
                    .duplicate_field_behavior = .use_last,
                }) catch return;
                self.ui = piece.value;
            }
        }

        const bases = protocol.get(parsed.value.object, "diffBase") orelse return;
        if (bases != .object) return;

        var iterator = bases.object.iterator();
        while (iterator.next()) |item| {
            if (item.value_ptr.* != .string) continue;
            const key = self.allocator.dupe(u8, item.key_ptr.*) catch continue;
            const value = self.allocator.dupe(u8, item.value_ptr.string) catch continue;
            self.bases.put(self.allocator, key, value) catch return;
        }
    }

    pub fn baseFor(self: *Settings, project: []const u8) []const u8 {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return self.bases.get(project) orelse default_base;
    }

    pub fn setBase(self: *Settings, project: []const u8, base: []const u8) !void {
        const key = try self.allocator.dupe(u8, project);
        const value = try self.allocator.dupe(u8, base);

        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        try self.bases.put(self.allocator, key, value);
        try self.save();
    }

    /// Current `ui` section as JSON, for `GET /api/settings`.
    pub fn uiJson(self: *Settings, allocator: std.mem.Allocator) ![]u8 {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);

        var out: Io.Writer.Allocating = .init(allocator);
        errdefer out.deinit();
        try std.json.Stringify.value(self.ui, .{}, &out.writer);
        return out.toOwnedSlice();
    }

    /// Merge the objects a browser sent into `ui` and store the result. Unknown keys are ignored so
    /// an older server survives a newer frontend.
    pub fn patchUi(self: *Settings, patch: std.json.ObjectMap) !void {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);

        var iterator = patch.iterator();
        while (iterator.next()) |item| {
            const key = item.key_ptr.*;
            const value = item.value_ptr.*;
            if (std.mem.eql(u8, key, "theme")) {
                if (value != .string) return error.BadValue;
                self.ui.theme = try self.allocator.dupe(u8, value.string);
            } else if (std.mem.eql(u8, key, "sidebar") or std.mem.eql(u8, key, "files") or
                std.mem.eql(u8, key, "show_thinking") or std.mem.eql(u8, key, "send_on_enter"))
            {
                if (value != .bool) return error.BadValue;
                const flag = value.bool;
                if (std.mem.eql(u8, key, "sidebar")) self.ui.sidebar = flag;
                if (std.mem.eql(u8, key, "files")) self.ui.files = flag;
                if (std.mem.eql(u8, key, "show_thinking")) self.ui.show_thinking = flag;
                if (std.mem.eql(u8, key, "send_on_enter")) self.ui.send_on_enter = flag;
            } else if (std.mem.eql(u8, key, "send_mode")) {
                if (value != .string) return error.BadValue;
                if (!std.mem.eql(u8, value.string, "steer") and !std.mem.eql(u8, value.string, "queue")) {
                    return error.BadValue;
                }
                self.ui.send_mode = try self.allocator.dupe(u8, value.string);
            } else if (std.mem.eql(u8, key, "sidebar_width") or std.mem.eql(u8, key, "files_width")) {
                if (value != .integer) return error.BadValue;
                const width = std.math.cast(u16, value.integer) orelse return error.BadValue;
                if (std.mem.eql(u8, key, "sidebar_width")) self.ui.sidebar_width = width;
                if (std.mem.eql(u8, key, "files_width")) self.ui.files_width = width;
            }
        }

        try self.save();
    }

    fn save(self: *Settings) !void {
        var out: Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();

        const writer = &out.writer;
        try writer.writeAll("{\n  \"server\": ");
        try std.json.Stringify.value(self.server, .{}, writer);
        try writer.writeAll(",\n  \"ui\": ");
        try std.json.Stringify.value(self.ui, .{}, writer);
        try writer.writeAll(",\n  \"diffBase\": {");

        var iterator = self.bases.iterator();
        var first = true;
        while (iterator.next()) |item| {
            if (!first) try writer.writeByte(',');
            first = false;
            try writer.writeByte('\n');
            try std.json.Stringify.value(item.key_ptr.*, .{}, writer);
            try writer.writeAll(": ");
            try std.json.Stringify.value(item.value_ptr.*, .{}, writer);
        }
        if (!first) try writer.writeByte('\n');
        try writer.writeAll("}\n}\n");

        var atomic = Io.Dir.cwd().createFileAtomic(self.io, self.path, .{ .replace = true }) catch
            return error.WriteFailed;
        defer atomic.deinit(self.io);

        atomic.file.writeStreamingAll(self.io, out.written()) catch return error.WriteFailed;
        atomic.replace(self.io) catch return error.WriteFailed;
    }
};

pub fn readFile(allocator: std.mem.Allocator, io: Io, path: []const u8) ![]u8 {
    var buffer: [8 * 1024]u8 = undefined;
    var file = Io.Dir.cwd().openFile(io, path, .{}) catch return error.NotFound;
    defer file.close(io);

    var stream = file.readerStreaming(io, &buffer);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    var chunk: [8 * 8192]u8 = undefined;
    while (true) {
        const read = stream.interface.readSliceShort(&chunk) catch break;
        if (read == 0) break;
        try out.appendSlice(allocator, chunk[0..read]);
    }
    return out.items;
}
