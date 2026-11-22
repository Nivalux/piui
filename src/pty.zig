//! A shell on the other end of a pseudo terminal.
//!
//! Pi is talked to through pipes; a shell cannot be. It wants a terminal: line
//! discipline, echo, a window size it can ask for, a controlling tty so Ctrl-C
//! reaches the job it should stop. That is what this opens.
//!
//! Zig 0.17 has no `forkpty`, and linking libc for one call would make the
//! whole binary dynamic, so the dance is done with the syscalls directly. The
//! child touches nothing but syscalls between the fork and the exec: no
//! allocation, no logger, no Io. Everything it needs is prepared first.

const std = @import("std");
const Io = std.Io;

const linux = std.os.linux;

/// The ioctl numbers of the tty driver. The encoding is the same on every
/// Linux port, so they are written out here rather than pulled from headers
/// that only exist when libc is linked.
const TIOCSPTLCK: u32 = 0x4004_5431;
const TIOCGPTPEER: u32 = 0x5441;
const TIOCSWINSZ: u32 = 0x5414;
const TIOCGWINSZ: u32 = 0x5413;
const TIOCSCTTY: u32 = 0x540E;

const ptmx = "/dev/ptmx";

pub const Error = error{
    PtyFailed,
    SpawnFailed,
    OutOfMemory,
};

pub const Options = struct {
    /// Program to run; `$SHELL` when this is empty.
    shell: []const u8 = "",
    /// Left to the program itself, which is what a shell opened in front of
    /// someone gets: nothing.
    args: []const []const u8 = &.{},
    cwd: []const u8,
    rows: u16 = 24,
    cols: u16 = 80,
    /// What the shell inherits. Passing an empty one leaves it without a PATH,
    /// so the caller is made to say which environment it means.
    environ: std.process.Environ,
};

/// The two ends of a fresh pseudo terminal.
const Pair = struct { master: i32, slave: i32 };

/// The size of the window, in the shape the kernel keeps it in.
pub const Window = struct { row: u16, col: u16, xpixel: u16 = 0, ypixel: u16 = 0 };

fn failed(rc: usize) bool {
    // A syscall in this range is a negated errno, nothing else can be.
    return rc > (@as(usize, 1) << (@typeInfo(usize).@"int".bits - 13));
}

fn openPair(rows: u16, cols: u16) !Pair {
    const flags: linux.O = .{ .ACCMODE = .RDWR, .CLOEXEC = true, .NOCTTY = true };

    const leader = linux.open(ptmx, flags, 0);
    if (failed(leader)) return error.PtyFailed;

    // The new ptmx is locked against other users until it is handed over. The
    // ioctl wants the address of the flag, not the flag itself.
    var unlock: c_int = 0;
    if (failed(linux.ioctl(@intCast(leader), TIOCSPTLCK, @intFromPtr(&unlock)))) {
        _ = linux.close(@intCast(leader));
        return error.PtyFailed;
    }

    const peer = linux.ioctl(@intCast(leader), TIOCGPTPEER, @as(usize, @as(u32, @bitCast(flags))));
    if (failed(peer)) {
        _ = linux.close(@intCast(leader));
        return error.PtyFailed;
    }

    const window = Window{ .row = rows, .col = cols };
    if (failed(linux.ioctl(@intCast(peer), TIOCSWINSZ, @intFromPtr(&window)))) {
        _ = linux.close(@intCast(peer));
        _ = linux.close(@intCast(leader));
        return error.PtyFailed;
    }

    return .{ .master = @intCast(leader), .slave = @intCast(peer) };
}

/// One shell attached to a pseudo terminal. The caller reads and writes the
/// master end; the kernel turns that into what the shell sees on its tty.
pub const Pty = struct {
    allocator: std.mem.Allocator,
    io: Io,
    /// Set for the child only: it execs the shell and never comes back.
    child: bool = false,
    pid: i32 = 0,
    master: Io.File,
    /// Set once the descriptors are let go; nothing can be read or written then.
    closed: bool = false,
    shell: []const u8,
    cwd: []const u8,
    rows: u16 = 24,
    cols: u16 = 80,

    /// Starts a shell in `cwd`. Returns the running side in the parent and a
    /// handle marked `child` in the child, which the caller must never touch.
    pub fn start(allocator: std.mem.Allocator, io: Io, options: Options) !*Pty {
        const pair = try openPair(options.rows, options.cols);

        const chosen = if (options.shell.len > 0)
            options.shell
        else
            std.process.Environ.getPosix(options.environ, "SHELL") orelse "/bin/sh";

        // Every byte the child will need has to exist before the fork: after it
        // there is no allocator to trust, only the kernel.
        const path = toTerm(allocator, chosen) catch |err| {
            closeFd(pair.slave);
            closeFd(pair.master);
            return err;
        };
        const dir = toTerm(allocator, options.cwd) catch |err| {
            closeFd(pair.slave);
            closeFd(pair.master);
            return err;
        };

        var argv: std.ArrayList(?[*:0]const u8) = .empty;
        errdefer argv.deinit(allocator);
        argv.append(allocator, path) catch return error.OutOfMemory;
        for (options.args) |argument| {
            const kept = toTerm(allocator, argument) catch return error.OutOfMemory;
            argv.append(allocator, kept) catch return error.OutOfMemory;
        }
        // A shell with no arguments and a tty in front of it is interactive,
        // and it reads the startup files its user expects it to read.
        argv.append(allocator, null) catch return error.OutOfMemory;

        var envp: std.ArrayList(?[*:0]const u8) = .empty;
        errdefer envp.deinit(allocator);
        for (options.environ.block.slice) |entry| {
            if (entry) |item| {
                if (std.mem.startsWith(u8, std.mem.span(item), "TERM=")) continue;
                if (std.mem.startsWith(u8, std.mem.span(item), "COLUMNS=")) continue;
                if (std.mem.startsWith(u8, std.mem.span(item), "LINES=")) continue;
            }
            envp.append(allocator, entry) catch return error.OutOfMemory;
        }
        const term = toTerm(allocator, "TERM=xterm-256color") catch return error.OutOfMemory;
        envp.append(allocator, term) catch return error.OutOfMemory;
        envp.append(allocator, null) catch return error.OutOfMemory;

        const parent: i32 = @intCast(linux.getpid());
        const pid: i32 = @intCast(linux.fork());
        if (pid < 0) {
            closeFd(pair.slave);
            closeFd(pair.master);
            return error.SpawnFailed;
        }

        if (pid == 0) childSide(pair, parent, dir, argv.items, envp.items);

        closeFd(pair.slave);

        const self = allocator.create(Pty) catch {
            closeFd(pair.master);
            return error.OutOfMemory;
        };
        self.* = .{
            .allocator = allocator,
            .io = io,
            .pid = pid,
            .master = .{ .handle = pair.master, .flags = .{ .nonblocking = false } },
            .shell = chosen,
            .cwd = options.cwd,
            .rows = options.rows,
            .cols = options.cols,
        };
        return self;
    }

    /// Bytes typed into the browser, written to the shell as if they came off
    /// a keyboard.
    pub fn write(self: *Pty, bytes: []const u8) void {
        if (self.gone()) return;
        self.master.writeStreamingAll(self.io, bytes) catch {};
    }

    /// Tells the kernel how big the window is, so the shell wraps and `tput`
    /// measures what the reader actually sees.
    pub fn resize(self: *Pty, rows: u16, cols: u16) void {
        if (self.gone()) return;
        if (rows == 0 or cols == 0) return;
        self.rows = rows;
        self.cols = cols;
        const size = Window{ .row = rows, .col = cols };
        _ = linux.ioctl(fdOf(self.master), TIOCSWINSZ, @intFromPtr(&size));
    }

    /// What the kernel thinks the window is. Anything inside the shell that
    /// asks — `stty`, a text editor, a progress bar — reads the same numbers.
    pub fn window(self: *Pty) Window {
        if (self.gone()) return .{ .row = 0, .col = 0 };
        var size = Window{ .row = self.rows, .col = self.cols };
        if (failed(linux.ioctl(fdOf(self.master), TIOCGWINSZ, @intFromPtr(&size)))) {
            return .{ .row = 0, .col = 0 };
        }
        return size;
    }

    /// Reads whatever the shell has written. Zero means the shell is gone.
    pub fn read(self: *Pty, into: []u8) usize {
        if (self.gone()) return 0;
        var chunks = [_][]u8{into};
        const got = self.master.readStreaming(self.io, &chunks) catch return 0;
        return if (got > into.len) into.len else got;
    }

    /// Stops the shell and everything still running in its window. A shell is
    /// a session leader, so its number is the number of its group, and a
    /// negative one addresses the group: the build it started goes down with it.
    pub fn kill(self: *Pty) void {
        if (self.pid <= 0) return;
        _ = linux.kill(-self.pid, .TERM);
    }

    /// Waits for the shell and reports its exit code, -1 when it was killed by
    /// a signal or never started.
    pub fn wait(self: *Pty) i32 {
        if (self.pid <= 0) return -1;
        var status: i32 = 0;
        while (true) {
            const done = linux.waitpid(self.pid, &status, 0);
            if (failed(done)) return -1;
            if (done == 0) continue;
            break;
        }
        // The raw waitpid status: exit code in bits 8..16, signal in 0..7.
        if (status & 0xff != 0) return -1;
        return @intCast((status >> 8) & 0xff);
    }

    /// Lets go of the terminal. Closing the master is what hangs the session up,
    /// so this is how a shell dies when its window closes — and why a piui that
    /// dies by any means, a crash or a kill -9 included, takes its shells along:
    /// the kernel closes the descriptors on its way out.
    ///
    /// The struct stays: a reader may be blocked on this descriptor right now,
    /// and a shell outlives no request that asks for it, so nothing here frees
    /// what a running task is holding.
    pub fn close(self: *Pty) void {
        if (self.gone()) return;
        closeFd(fdOf(self.master));
        self.closed = true;
    }

    /// True once the descriptors are gone, which is when nothing more can be
    /// read out of the shell or written into it.
    fn gone(self: *const Pty) bool {
        return self.closed;
    }
};

/// The child half. Nothing here may allocate, log or touch the Io runtime: the
/// process is a copy and its runtime is not its own.
fn childSide(
    pair: Pair,
    parent: i32,
    dir: [*:0]const u8,
    argv: []?[*:0]const u8,
    envp: []?[*:0]const u8,
) noreturn {
    // The first thing, so there is no window in which piui could die and leave
    // a shell behind: the kernel owes this process a kill when the thread that
    // made it goes away, by crash or by signal, and nobody is left to clean up.
    _ = linux.prctl(@intFromEnum(linux.PR.SET_PDEATHSIG), @intFromEnum(linux.SIG.KILL), 0, 0, 0);
    if (linux.getppid() != parent) linux.exit(0);

    // Its own session, so that the terminal becomes a controlling one and Ctrl-C
    // lands on the job in the foreground of this window rather than on piui.
    _ = linux.setsid();
    _ = linux.ioctl(pair.slave, TIOCSCTTY, 1);
    _ = linux.chdir(dir);

    var index: i32 = 0;
    while (index < 3) : (index += 1) {
        if (index == pair.slave) continue;
        _ = linux.dup2(pair.slave, index);
    }
    if (pair.slave > 2) closeFd(pair.slave);
    closeFd(pair.master);

    // Both arrays were ended with a null before the fork, which is all the
    // sentinel the syscall asks for.
    _ = linux.execve(argv[0].?, @ptrCast(argv.ptr), @ptrCast(envp.ptr));
    linux.exit(127);
}

fn closeFd(fd: i32) void {
    _ = linux.close(fd);
}

fn fdOf(file: Io.File) i32 {
    return file.handle;
}

fn toTerm(allocator: std.mem.Allocator, text: []const u8) ![:0]const u8 {
    return allocator.dupeSentinel(u8, text, 0);
}
