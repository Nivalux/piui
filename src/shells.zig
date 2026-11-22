//! The shells that are open right now, and the way to them from the browser.
//!
//! A shell outlives the request that opened it, just as a chat does: it is
//! started once, its output is pushed to whoever is listening, and it is stopped
//! by name. What it does not do is come back — a shell whose reader went away
//! for good is a shell nobody is looking at, and it goes.

const std = @import("std");
const Io = std.Io;

const pty = @import("pty.zig");
const hub = @import("hub.zig");
const json = @import("json.zig");
const log = @import("log.zig");

const Subscriber = hub.Subscriber;

/// A shell a browser tab is showing.
pub const Shell = struct {
    id: []const u8,
    cwd: []const u8,
    process: *pty.Pty,
    /// Set once the shell has stopped; the code it left is kept for the notice.
    closed: bool = false,
    exit_code: i32 = -1,
    created_epoch: i64,
    last_output_epoch: i64,
    /// When the last reader left. A shell nobody has looked at for a while is
    /// one that was closed on the way out without saying so.
    orphaned_epoch: i64 = 0,
    /// What the shell wrote most recently, kept so that a browser arriving late —
    /// or coming back after a dropped connection — sees a screen instead of a
    /// blank one.
    backlog: std.ArrayList(u8) = .empty,
    subscribers: std.ArrayList(*Subscriber) = .empty,
    lock: Io.Mutex = .init,
};

/// How much of a shell's output to keep for the next reader. A screen full is a
/// couple of kilobytes; this is room to spare.
pub const screen_keep_bytes = 32 * 1024;

pub const ShellInfo = struct {
    id: []const u8,
    cwd: []const u8,
    closed: bool,
    exitCode: i32,
    createdMs: i64,
    lastOutputMs: i64,
};

pub const Error = error{
    NoWorkdir,
    OutOfMemory,
    SpawnFailed,
};

/// What the browser is told about a shell before it draws anything.
const Announce = struct {
    type: []const u8 = "piui",
    event: []const u8 = "shell",
    shell: ShellInfo,
};

/// A chunk of what the shell wrote, in the only shape that survives an event
/// stream: control characters do not travel as themselves.
pub const Output = struct {
    type: []const u8 = "piui",
    event: []const u8 = "shellOut",
    id: []const u8,
    data: []const u8,
};

/// The shell is gone, and this is what it left behind.
const Ended = struct {
    type: []const u8 = "piui",
    event: []const u8 = "shellExit",
    id: []const u8,
    code: i32,
};

pub const Pool = struct {
    allocator: std.mem.Allocator,
    io: Io,
    group: *Io.Group,
    /// What a shell inherits. A shell without a PATH is a shell that cannot do
    /// anything, so this is the environment piui was started with.
    environ: std.process.Environ,
    /// How long a shell may go without a reader before it is taken as closed.
    abandoned_after_ms: i64 = 30 * 60 * 1000,

    shells: std.StringHashMapUnmanaged(*Shell) = .empty,
    lock: Io.Mutex = .init,
    counter: u32 = 0,

    /// Opens a shell in `cwd` and starts reading it.
    pub fn open(self: *Pool, cwd: []const u8, rows: u16, cols: u16) Error!*Shell {
        if (cwd.len == 0) return error.NoWorkdir;

        const number = blk: {
            self.lock.lockUncancelable(self.io);
            defer self.lock.unlock(self.io);
            self.counter += 1;
            break :blk self.counter;
        };
        const id = std.fmt.allocPrint(self.allocator, "s{d}", .{number}) catch return error.OutOfMemory;

        const process = pty.Pty.start(self.allocator, self.io, .{
            .cwd = cwd,
            .rows = rows,
            .cols = cols,
            .environ = self.environ,
        }) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            else => return error.SpawnFailed,
        };

        const kept_cwd = self.allocator.dupe(u8, cwd) catch return error.OutOfMemory;
        const shell = self.allocator.create(Shell) catch return error.OutOfMemory;
        shell.* = .{
            .id = id,
            .cwd = kept_cwd,
            .process = process,
            .created_epoch = json.epochMs(self.io),
            .last_output_epoch = json.epochMs(self.io),
        };

        self.lock.lockUncancelable(self.io);
        self.shells.put(self.allocator, id, shell) catch {
            self.lock.unlock(self.io);
            return error.OutOfMemory;
        };
        self.lock.unlock(self.io);

        self.group.concurrent(self.io, pump, .{ self, shell }) catch {
            shell.process.close();
            self.close(shell, "reader failed to start");
            return error.SpawnFailed;
        };

        log.info("shell started {s} pid={d} cwd={s}", .{ id, shell.process.pid, cwd });
        self.announce(shell);
        return shell;
    }

    pub fn get(self: *Pool, id: []const u8) ?*Shell {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return self.shells.get(id);
    }

    /// The shells a browser should open tabs for: the ones still standing.
    pub fn alive(self: *Pool, a: std.mem.Allocator) []const ShellInfo {
        var list: std.ArrayList(ShellInfo) = .empty;

        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);

        const now = json.epochMs(self.io);

        // Given-up shells are collected first and dropped afterwards: an
        // iterator may not be disturbed while it walks.
        var abandoned: std.ArrayList(*Shell) = .empty;
        var iterator = self.shells.iterator();
        while (iterator.next()) |item| {
            const shell = item.value_ptr.*;
            if (self.givenUp(shell, now)) {
                abandoned.append(self.allocator, shell) catch {};
                continue;
            }
            if (shell.closed) continue;
            list.append(a, infoOf(shell, self.io)) catch continue;
        }
        for (abandoned.items) |shell| {
            _ = self.shells.remove(shell.id);
            stop(shell);
        }

        return list.items;
    }

    /// A shell whose reader left and did not come back.
    fn givenUp(self: *Pool, shell: *Shell, now: i64) bool {
        shell.lock.lockUncancelable(self.io);
        defer shell.lock.unlock(self.io);
        if (shell.subscribers.items.len > 0 or shell.orphaned_epoch == 0) return false;
        return now - shell.orphaned_epoch > self.abandoned_after_ms;
    }

    pub fn write(self: *Pool, shell: *Shell, bytes: []const u8) void {
        _ = self;
        if (shell.closed) return;
        shell.process.write(bytes);
    }

    pub fn resize(self: *Pool, shell: *Shell, rows: u16, cols: u16) void {
        _ = self;
        if (shell.closed) return;
        shell.process.resize(rows, cols);
    }

    pub fn infoOf(shell: *Shell, io: Io) ShellInfo {
        shell.lock.lockUncancelable(io);
        defer shell.lock.unlock(io);
        return .{
            .id = shell.id,
            .cwd = shell.cwd,
            .closed = shell.closed,
            .exitCode = shell.exit_code,
            .createdMs = shell.created_epoch,
            .lastOutputMs = shell.last_output_epoch,
        };
    }

    fn announce(self: *Pool, shell: *Shell) void {
        const payload = json.encode(self.allocator, Announce{ .shell = infoOf(shell, self.io) }) catch return;
        defer self.allocator.free(payload);
        self.broadcast(shell, payload);
    }

    pub fn subscribe(self: *Pool, shell: *Shell) ?*Subscriber {
        const sub = self.allocator.create(Subscriber) catch return null;
        sub.* = .{ .allocator = self.allocator };

        shell.lock.lockUncancelable(self.io);
        shell.orphaned_epoch = 0;
        shell.subscribers.append(self.allocator, sub) catch {};
        shell.lock.unlock(self.io);
        return sub;
    }

    pub fn unsubscribe(self: *Pool, shell: *Shell, sub: *Subscriber) void {
        shell.lock.lockUncancelable(self.io);
        for (shell.subscribers.items, 0..) |item, index| {
            if (item != sub) continue;
            _ = shell.subscribers.orderedRemove(index);
            break;
        }
        if (shell.subscribers.items.len == 0) shell.orphaned_epoch = json.epochMs(self.io);
        shell.lock.unlock(self.io);
        sub.close(self.io);
    }

    pub fn broadcast(self: *Pool, shell: *Shell, text: []const u8) void {
        shell.lock.lockUncancelable(self.io);
        defer shell.lock.unlock(self.io);
        for (shell.subscribers.items) |sub| sub.push(self.io, text);
    }

    /// Takes the shell out of the list and stops it.
    pub fn close(self: *Pool, shell: *Shell, reason: []const u8) void {
        log.info("closing shell {s}: {s}", .{ shell.id, reason });

        self.lock.lockUncancelable(self.io);
        _ = self.shells.remove(shell.id);
        self.lock.unlock(self.io);

        stop(shell);
    }

    /// Turns the listeners off and stops the shell. The reader task is the one
    /// that lets go of the descriptors, because it is the one that may be
    /// waiting on them.
    fn stop(shell: *Shell) void {
        shell.lock.lockUncancelable(shell.process.io);
        const subscribers = shell.subscribers.clone(shell.process.allocator)
            catch std.ArrayList(*Subscriber).empty;
        shell.subscribers.clearRetainingCapacity();
        shell.lock.unlock(shell.process.io);

        for (subscribers.items) |sub| sub.close(shell.process.io);
        shell.process.kill();
    }
};

/// Carries the shell's output to whoever is listening, and reports the moment
/// it stops. One of these runs per shell for as long as the shell does.
fn pump(pool: *Pool, shell: *Shell) void {
    var buffer: [8 * 1024]u8 = undefined;
    while (true) {
        const got = shell.process.read(&buffer);
        if (got == 0) break;

        shell.lock.lockUncancelable(pool.io);
        shell.last_output_epoch = json.epochMs(pool.io);
        if (shell.backlog.appendSlice(pool.allocator, buffer[0..got])) {
            trimBacklog(shell);
        } else |_| {
            shell.lock.unlock(pool.io);
            break;
        }
        shell.lock.unlock(pool.io);

        emit(pool, shell, buffer[0..got]);
    }

    const code = shell.process.wait();
    shell.lock.lockUncancelable(pool.io);
    shell.closed = true;
    shell.exit_code = code;
    shell.orphaned_epoch = json.epochMs(pool.io);
    shell.lock.unlock(pool.io);

    const notice = json.encode(pool.allocator, Ended{ .id = shell.id, .code = code }) catch return;
    defer pool.allocator.free(notice);
    pool.broadcast(shell, notice);

    shell.process.close();
    log.info("shell ended {s} code={d}", .{ shell.id, code });
}

/// Drops the oldest output once what is kept grows past a screen. The caller
/// holds the shell's lock.
fn trimBacklog(shell: *Shell) void {
    const length = shell.backlog.items.len;
    if (length <= screen_keep_bytes) return;
    const cut = length - screen_keep_bytes;
    std.mem.copyForwards(u8, shell.backlog.items, shell.backlog.items[cut..]);
    shell.backlog.shrinkRetainingCapacity(screen_keep_bytes);
}

/// What a reader arriving now has to draw: everything kept so far, copied out so
/// that the shell can carry on writing while it is being sent.
pub fn backlogOf(shell: *Shell, a: std.mem.Allocator) ?[]u8 {
    shell.lock.lockUncancelable(shell.process.io);
    defer shell.lock.unlock(shell.process.io);
    return a.dupe(u8, shell.backlog.items) catch null;
}

/// One read turned into one event. The encoding is base64 because a terminal
/// speaks in control characters and an event stream is made of text.
fn emit(pool: *Pool, shell: *Shell, bytes: []const u8) void {
    const a = pool.allocator;

    const encoded = a.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len)) catch return;
    defer a.free(encoded);
    const text = std.base64.standard.Encoder.encode(encoded, bytes);

    const payload = json.encode(a, Output{ .id = shell.id, .data = text }) catch return;
    defer a.free(payload);
    pool.broadcast(shell, payload);
}
