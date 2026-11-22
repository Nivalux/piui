const std = @import("std");
const Io = std.Io;
const testing = std.testing;
const piui = @import("piui");
const pty = piui.pty;

/// An environment of the shape piui hands a shell: the entries given, and the ones the terminal has
/// to own.
fn environOf(a: std.mem.Allocator, given: []const []const u8) !std.process.Environ {
    var entries: std.ArrayList(?[*:0]const u8) = .empty;
    for (given) |entry| entries.append(a, a.dupeSentinel(u8, entry, 0) catch return error.OutOfMemory) catch
        return error.OutOfMemory;
    entries.append(a, null) catch return error.OutOfMemory;

    const ended: [*:null]const ?[*:0]const u8 = @ptrCast(entries.items);
    return .{ .block = .{ .slice = ended[0 .. entries.items.len - 1 :null] } };
}

/// Reads until the shell stops writing, so a test never waits on a guess.
fn slurp(shell: *pty.Pty, limit: usize) []u8 {
    var out: std.ArrayList(u8) = .empty;
    var buffer: [4096]u8 = undefined;
    while (out.items.len < limit) {
        const got = shell.read(&buffer);
        if (got == 0) break;
        out.appendSlice(shell.allocator, buffer[0..got]) catch break;
    }
    return out.items;
}

/// One shell, one command, everything it wrote.
fn run(io: Io, a: std.mem.Allocator, cwd: []const u8, command: []const u8) ![]u8 {
    const shell = try pty.Pty.start(a, io, .{
        .shell = "/bin/sh",
        .args = &.{ "-c", command },
        .cwd = cwd,
        .rows = 30,
        .cols = 120,
        .environ = try environOf(a, &.{}),
    });
    defer shell.close();

    const text = slurp(shell, 64 * 1024);
    _ = shell.wait();
    return text;
}

fn context(
    allocator: std.mem.Allocator,
    comptime body: fn (Io, std.mem.Allocator, []const u8) anyerror!void,
) !void {
    var threaded: Io.Threaded = .init(allocator, .{});
    defer threaded.deinit();

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();

    var root = testing.tmpDir(.{});
    defer root.cleanup();

    var buffer: [4096]u8 = undefined;
    const length = root.dir.realPath(threaded.io(), &buffer) catch return error.SkipZigTest;
    try body(threaded.io(), arena.allocator(), buffer[0..length]);
}

test "a shell writes to its terminal and the master reads it back" {
    try context(testing.allocator, struct {
        fn go(io: Io, a: std.mem.Allocator, cwd: []const u8) !void {
            const out = try run(io, a, cwd, "echo hello-from-pty");
            try testing.expect(std.mem.indexOf(u8, out, "hello-from-pty") != null);
        }
    }.go);
}

test "a tty is a tty: a stdin to read from and a window measured in rows" {
    try context(testing.allocator, struct {
        fn go(io: Io, a: std.mem.Allocator, cwd: []const u8) !void {
            const shell = try pty.Pty.start(a, io, .{
                .shell = "/bin/sh",
                .args = &.{ "-c", "test -t 0 && test -t 1 && echo both-ends" },
                .cwd = cwd,
                .rows = 30,
                .cols = 120,
                .environ = try environOf(a, &.{}),
            });
            defer shell.close();

            try testing.expect(std.mem.indexOf(u8, slurp(shell, 4096), "both-ends") != null);

            const size = shell.window();
            try testing.expectEqual(@as(u16, 30), size.row);
            try testing.expectEqual(@as(u16, 120), size.col);
        }
    }.go);
}

test "the shell starts in the folder it was opened in" {
    try context(testing.allocator, struct {
        fn go(io: Io, a: std.mem.Allocator, cwd: []const u8) !void {
            const out = try run(io, a, cwd, "pwd");
            try testing.expect(std.mem.indexOf(u8, out, cwd) != null);
        }
    }.go);
}

test "the shell is handed the environment, and a terminal it can be typed into" {
    try context(testing.allocator, struct {
        fn go(io: Io, a: std.mem.Allocator, cwd: []const u8) !void {
            const shell = try pty.Pty.start(a, io, .{
                .shell = "/bin/sh",
                .args = &.{ "-c", "printf '%s/%s\\n' \"$piui_test\" \"$TERM\"" },
                .cwd = cwd,
                .environ = try environOf(a, &.{ "piui_test=from-the-parent", "TERM=dumb", "COLUMNS=7" }),
            });
            defer shell.close();

            const out = slurp(shell, 4096);
            try testing.expect(std.mem.indexOf(u8, out, "from-the-parent/xterm-256color") != null);
        }
    }.go);
}

test "what is typed reaches the shell's stdin, and is echoed on the way" {
    try context(testing.allocator, struct {
        fn go(io: Io, a: std.mem.Allocator, cwd: []const u8) !void {
            const shell = try pty.Pty.start(a, io, .{
                .shell = "/bin/sh",
                .args = &.{ "-c", "read line; printf 'got=%s\\n' \"$line\"" },
                .cwd = cwd,
                .environ = try environOf(a, &.{}),
            });
            defer shell.close();

            shell.write("typed-line\n");

            const out = slurp(shell, 16 * 1024);
            try testing.expect(std.mem.indexOf(u8, out, "got=typed-line") != null);
        }
    }.go);
}

test "a window that changes size is a window the kernel passes on" {
    try context(testing.allocator, struct {
        fn go(io: Io, a: std.mem.Allocator, cwd: []const u8) !void {
            const shell = try pty.Pty.start(a, io, .{
                .shell = "/bin/sh",
                .args = &.{ "-c", "sleep 20" },
                .cwd = cwd,
                .environ = try environOf(a, &.{}),
            });
            defer shell.close();

            try testing.expectEqual(@as(u16, 24), shell.window().row);

            shell.resize(50, 200);
            try testing.expectEqual(@as(u16, 50), shell.window().row);
            try testing.expectEqual(@as(u16, 200), shell.window().col);
        }
    }.go);
}

test "the exit code of the shell survives the trip" {
    try context(testing.allocator, struct {
        fn go(io: Io, a: std.mem.Allocator, cwd: []const u8) !void {
            const shell = try pty.Pty.start(a, io, .{
                .shell = "/bin/sh",
                .args = &.{ "-c", "exit 3" },
                .cwd = cwd,
                .environ = try environOf(a, &.{}),
            });
            defer shell.close();
            _ = slurp(shell, 4096);
            try testing.expectEqual(@as(i32, 3), shell.wait());
        }
    }.go);
}

test "closing the window hangs the shell up" {
    try context(testing.allocator, struct {
        fn go(io: Io, a: std.mem.Allocator, cwd: []const u8) !void {
            const shell = try pty.Pty.start(a, io, .{
                .shell = "/bin/sh",
                .args = &.{ "-c", "echo awake; sleep 30" },
                .cwd = cwd,
                .environ = try environOf(a, &.{}),
            });

            try testing.expect(std.mem.indexOf(u8, slurp(shell, 4096), "awake") != null);
            const pid = shell.pid;

            shell.close();

            try testing.expectEqual(@as(i32, 0), eventuallyGone(io, pid));
        }
    }.go);
}

test "a kill takes the jobs running in the window with it" {
    try context(testing.allocator, struct {
        fn go(io: Io, a: std.mem.Allocator, cwd: []const u8) !void {
            const shell = try pty.Pty.start(a, io, .{
                .shell = "/bin/sh",
                .args = &.{ "-c", "while :; do :; done & echo job=$!" },
                .cwd = cwd,
                .environ = try environOf(a, &.{}),
            });
            defer shell.close();

            const text = slurp(shell, 4096);
            const mark = std.mem.indexOf(u8, text, "job=") orelse return error.TestUnexpectedResult;
            const started = std.fmt.parseInt(i32, std.mem.trim(u8, text[mark + 4 ..], "\r\n "), 10) catch
                return error.TestUnexpectedResult;

            shell.kill();
            _ = shell.wait();

            try testing.expectEqual(@as(i32, 0), eventuallyGone(io, started));
        }
    }.go);
}

/// Waits for the kernel to stop answering for a process, and says how many tries it took; zero
/// means it is gone. One that is only still lying around as a zombie counts as gone: it runs no
/// more.
fn eventuallyGone(io: Io, pid: i32) i32 {
    var tries: i32 = 0;
    while (tries < 40) : (tries += 1) {
        if (!alive(io, pid)) return 0;
        const pause = std.os.linux.timespec{ .sec = 0, .nsec = 50_000_000 };
        _ = std.os.linux.nanosleep(&pause, null);
    }
    return tries;
}

fn alive(io: Io, pid: i32) bool {
    var name: [64]u8 = undefined;
    const path = std.fmt.bufPrint(&name, "/proc/{d}/stat", .{pid}) catch return false;

    var buffer: [4096]u8 = undefined;
    const handle = Io.Dir.cwd().openFile(io, path, .{}) catch return false;
    defer handle.close(io);

    var source = handle.reader(io, &buffer);
    const stat = source.interface.allocRemaining(testing.allocator, .limited(4096)) catch return false;

    const closed = std.mem.indexOf(u8, stat, ") ") orelse return false;
    return stat[closed + 2] != 'Z';
}
