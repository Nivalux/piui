const std = @import("std");
const Io = std.Io;
const piui = @import("piui");
const auth = piui.auth;
const dirs = piui.dirs;
const hub = piui.hub;
const git = piui.git;
const json = piui.json;
const server = piui.server;
const sessions = piui.sessions;
const settings = piui.settings;
const shells = piui.shells;
const log = piui.log;

pub fn main(minimal: std.process.Init.Minimal) !void {
    const a = std.heap.smp_allocator;

    const over = try parseArgs(minimal.args);
    if (over.help) return;

    var threaded: std.Io.Threaded = .init(a, .{
        .argv0 = .init(minimal.args),
        .environ = minimal.environ,
    });
    const io = threaded.io();
    log.init(io);

    const home = std.process.Environ.getPosix(minimal.environ, "HOME") orelse ".";
    const agent = std.process.Environ.getPosix(minimal.environ, "PI_CODING_AGENT_DIR") orelse
        (std.fs.path.join(a, &.{ home, ".pi", "agent" }) catch ".pi/agent");
    const config_path = over.config_path orelse try std.fs.path.join(a, &.{ home, ".piui", "config.json" });

    if (std.fs.path.dirname(config_path)) |dir| {
        Io.Dir.cwd().createDirPath(io, dir) catch {};
    }

    const config = try settings.Settings.load(a, io, config_path);
    const here = dirs.current(a, io) catch ".";
    const resolved = resolve(a, over, config.server, home, here, agent);

    Io.Dir.cwd().createDirPath(io, resolved.scratch_root) catch {};

    const token_dir = std.fs.path.dirname(config_path) orelse ".";
    const token_path = try std.fs.path.join(a, &.{ token_dir, "token" });
    const token = if (over.token) |given|
        (auth.Token.fromHex(given) orelse {
            std.debug.print("token must be 40 hex characters\n", .{});
            return error.BadToken;
        })
    else
        try auth.Token.loadOrCreate(a, io, token_path);

    const index = sessions.Index{ .allocator = a, .io = io, .root = resolved.sessions_root };
    const tabs_path = try std.fs.path.join(a, &.{ token_dir, "tabs.json" });

    const center = try a.create(hub.Hub);
    center.* = .{
        .allocator = a,
        .io = io,
        .group = undefined,
        .pi_bin = resolved.pi_bin,
        .scratch_root = resolved.scratch_root,
        .sessions_root = resolved.sessions_root,
        .idle_after_ms = resolved.idle_seconds * 1000,
        .state_path = tabs_path,
        .restored = healed(a, home, here, hub.Hub.loadSaved(a, io, tabs_path)),
    };

    var group: Io.Group = .init;
    center.group = &group;

    const shell_pool = try a.create(shells.Pool);
    shell_pool.* = .{
        .allocator = a,
        .io = io,
        .group = &group,
        .environ = minimal.environ,
    };

    const web = try a.create(server.Server);
    web.* = .{ .options = .{
        .allocator = a,
        .io = io,
        .hub = center,
        .shells = shell_pool,
        .index = index,
        .config = config,
        .token = token,
        .web_root = over.web_root,
    } };

    var stop: std.atomic.Value(bool) = .init(false);
    group.concurrent(io, reap, .{ center, &stop }) catch {};

    const lock_path = try std.fs.path.join(a, &.{ token_dir, "piui.lock" });
    var lock_file = try Io.Dir.cwd().createFile(io, lock_path, .{});
    const held = lock_file.tryLock(io, .exclusive) catch |err| {
        std.debug.print("cannot lock {s}: {t}\n", .{ lock_path, err });
        return err;
    };
    if (!held) {
        std.debug.print("another piui is already running: {s} is locked\n", .{lock_path});
        return error.AlreadyRunning;
    }

    const address = try std.Io.net.IpAddress.parseIp4(resolved.host, resolved.port);
    var listener = try address.listen(io, .{ .reuse_address = true });
    defer listener.deinit(io);
    group.concurrent(io, hub.Hub.warm, .{center}) catch {};

    std.debug.print("piui on http://{s}:{d}\n", .{ resolved.host, resolved.port });
    std.debug.print("log lines on stderr, times in UTC\n", .{});
    if (center.restored.len > 0) std.debug.print("{d} chat(s) to put back\n", .{center.restored.len});
    std.debug.print("token  {s}\n       (also in {s})\n", .{ token.hex(), token_path });

    while (true) {
        const connection = listener.accept(io) catch continue;
        group.concurrent(io, serve, .{ web, connection }) catch connection.close(io);
    }
}

fn serve(web: *server.Server, connection: std.Io.net.Stream) void {
    defer connection.close(web.options.io);
    web.serve(connection);
}

/// A workdir saved by an older piui can still be the relative string it wrote `~` into. The folder
/// it names is real, so the path is finished the way it was finished back then, and the chat finds
/// its files again.
fn healed(a: std.mem.Allocator, home: []const u8, here: []const u8, saved: []const hub.Saved) []const hub.Saved {
    const copy = a.dupe(hub.Saved, saved) catch return saved;
    for (copy) |*entry| entry.cwd = dirs.wanted(a, home, here, entry.cwd) catch entry.cwd;
    return copy;
}

fn reap(center: *hub.Hub, stop: *std.atomic.Value(bool)) void {
    center.reap(stop);
}

/// Command line, then config file, then the built-in default: a flag has to win over a file that
/// was written weeks ago, and the file over a default.
fn resolve(
    a: std.mem.Allocator,
    over: Overrides,
    file: settings.Server,
    home: []const u8,
    here: []const u8,
    agent: []const u8,
) struct {
    host: []const u8,
    port: u16,
    pi_bin: []const u8,
    sessions_root: []const u8,
    scratch_root: []const u8,
    idle_seconds: i64,
} {
    var host = file.host;
    var port = file.port;
    if (over.addr) |spec| {
        const colon = std.mem.indexOfScalar(u8, spec, ':') orelse {
            std.debug.print("addr wants host:port, got {s}\n", .{spec});
            std.process.exit(1);
        };
        host = spec[0..colon];
        port = std.fmt.parseInt(u16, spec[colon + 1 ..], 10) catch {
            std.debug.print("addr port is not a number: {s}\n", .{spec});
            std.process.exit(1);
        };
    }

    return .{
        .host = host,
        .port = port,
        .pi_bin = over.pi_bin orelse file.pi,
        .sessions_root = dirs.wanted(
            a,
            home,
            here,
            over.sessions_root orelse
                (if (file.sessions.len > 0) file.sessions else std.fs.path.join(a, &.{ agent, "sessions" }) catch "."),
        ) catch ".",
        .scratch_root = dirs.wanted(
            a,
            home,
            here,
            over.scratch_root orelse
                (if (file.scratch.len > 0) file.scratch else std.fs.path.join(a, &.{ home, ".piui", "scratch" }) catch "."),
        ) catch ".",
        .idle_seconds = over.idle_seconds orelse file.idle_seconds,
    };
}

const Overrides = struct {
    addr: ?[]const u8 = null,
    pi_bin: ?[]const u8 = null,
    sessions_root: ?[]const u8 = null,
    config_path: ?[]const u8 = null,
    scratch_root: ?[]const u8 = null,
    web_root: ?[]const u8 = null,
    idle_seconds: ?i64 = null,
    token: ?[]const u8 = null,
    help: bool = false,
};

fn parseArgs(args: std.process.Args) !Overrides {
    var result: Overrides = .{};

    var iterator = args.iterate();
    _ = iterator.next();

    while (iterator.next()) |flag| {
        if (eq(flag, "-h") or eq(flag, "--help")) {
            std.debug.print(
                \\piui [options]
                \\  --addr <host:port>   listen address (default 127.0.0.1:7788)
                \\  --token <hex>        40 hex characters instead of the stored one
                \\  --pi <path>          pi binary (default "pi")
                \\  --sessions <dir>     pi session store (default ~/.pi/agent/sessions)
                \\  --config <file>      piui settings (default ~/.piui/config.json)
                \\  --scratch <dir>      workdirs for chats without a project
                \\  --web <dir>          serve web/ from disk instead of embedded
                \\  --idle <seconds>     reclaim idle workers (default 1800, 0 disables)
                \\
                \\Every option also has a place in the config file under "server", so a
                \\port can be set once instead of typed again. The token is generated on
                \\first start and kept next to the config with mode 0600.
                \\
            , .{});
            result.help = true;
            return result;
        } else if (valueOf(flag, "--addr")) |_| {
            result.addr = iterator.next() orelse return error.MissingValue;
        } else if (valueOf(flag, "--token")) |_| {
            result.token = iterator.next() orelse return error.MissingValue;
        } else if (valueOf(flag, "--pi")) |_| {
            result.pi_bin = iterator.next() orelse return error.MissingValue;
        } else if (valueOf(flag, "--sessions")) |_| {
            result.sessions_root = iterator.next() orelse return error.MissingValue;
        } else if (valueOf(flag, "--config")) |_| {
            result.config_path = iterator.next() orelse return error.MissingValue;
        } else if (valueOf(flag, "--scratch")) |_| {
            result.scratch_root = iterator.next() orelse return error.MissingValue;
        } else if (valueOf(flag, "--web")) |_| {
            result.web_root = iterator.next() orelse return error.MissingValue;
        } else if (valueOf(flag, "--idle")) |_| {
            result.idle_seconds = try std.fmt.parseInt(i64, iterator.next() orelse return error.MissingValue, 10);
        } else {
            std.debug.print("unknown option {s}\n", .{flag});
            return error.BadArgument;
        }
    }
    return result;
}

fn eq(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}

fn valueOf(flag: []const u8, name: []const u8) ?[]const u8 {
    if (std.mem.eql(u8, flag, name)) return name;
    return null;
}
