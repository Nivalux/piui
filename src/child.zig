const std = @import("std");
const Io = std.Io;

pub const Options = struct {
    bin: []const u8,
    args: []const []const u8,
    cwd: []const u8,
};

pub const Error = error{ SpawnFailed, LostStdin } || Io.Writer.Error;

/// One child process with its three pipes handed to the caller. How it is
/// invoked is the caller's business; this only owns the pipes.
///
/// The child is not bound to the task that spawned it: the pump task reads
/// stdout, another task drains stderr, any request task may call `send`.
pub const Child = struct {
    allocator: std.mem.Allocator,
    io: Io,
    proc: std.process.Child,
    stdin: Io.File,
    stdout: Io.File,
    stderr: Io.File,
    write_lock: Io.Mutex = .init,

    pub fn spawn(allocator: std.mem.Allocator, io: Io, options: Options) !*Child {
        var argv: std.ArrayList([]const u8) = .empty;
        defer argv.deinit(allocator);
        try argv.append(allocator, options.bin);
        for (options.args) |arg| try argv.append(allocator, arg);

        const proc = std.process.spawn(io, .{
            .argv = argv.items,
            .cwd = .{ .path = options.cwd },
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = .pipe,
        }) catch return error.SpawnFailed;

        const stdin = proc.stdin orelse return error.LostStdin;
        const stdout = proc.stdout orelse return error.LostStdin;
        const stderr = proc.stderr orelse return error.LostStdin;

        const self = try allocator.create(Child);
        self.* = .{
            .allocator = allocator,
            .io = io,
            .proc = proc,
            .stdin = stdin,
            .stdout = stdout,
            .stderr = stderr,
        };
        return self;
    }

    pub fn send(self: *Child, record: []const u8) Error!void {
        self.write_lock.lockUncancelable(self.io);
        defer self.write_lock.unlock(self.io);
        self.stdin.writeStreamingAll(self.io, record) catch return error.LostStdin;
    }

    pub fn closeStdin(self: *Child) void {
        self.stdin.close(self.io) catch {};
    }

    pub fn kill(self: *Child) void {
        self.proc.kill(self.io);
    }

    pub fn wait(self: *Child) !std.process.Child.Term {
        return self.proc.wait(self.io);
    }
};

/// Drains a pipe into a fixed-size tail, keeping the last bytes only.
pub const Tail = struct {
    limit: usize,
    bytes: std.ArrayList(u8) = .empty,
    lock: Io.Mutex = .init,

    pub fn append(self: *Tail, allocator: std.mem.Allocator, io: Io, chunk: []const u8) !void {
        self.lock.lockUncancelable(io);
        defer self.lock.unlock(io);
        try self.bytes.appendSlice(allocator, chunk);
        if (self.bytes.items.len > self.limit) {
            const drop = self.bytes.items.len - self.limit;
            std.mem.copyForwards(u8, self.bytes.items, self.bytes.items[drop..]);
            self.bytes.shrinkRetainingCapacity(self.limit);
        }
    }

    pub fn snapshot(self: *Tail, allocator: std.mem.Allocator, io: Io) ![]u8 {
        self.lock.lockUncancelable(io);
        defer self.lock.unlock(io);
        return allocator.dupe(u8, self.bytes.items);
    }
};

/// Reads chunks until end of stream, keeping the last bytes in `tail`.
pub fn drain(allocator: std.mem.Allocator, io: Io, file: Io.File, tail: *Tail) void {
    var buffer: [8 * 1024]u8 = undefined;
    while (true) {
        var chunks = [_][]u8{&buffer};
        const read = file.readStreaming(io, &chunks) catch break;
        if (read == 0) break;
        tail.append(allocator, io, buffer[0..read]) catch break;
    }
}
