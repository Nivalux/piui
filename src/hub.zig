const std = @import("std");
const Io = std.Io;
const child = @import("child.zig");
const dirs = @import("dirs.zig");
const framing = @import("framing.zig");
const protocol = @import("protocol.zig");
const json = @import("json.zig");
const log = @import("log.zig");
const sessions = @import("sessions.zig");
const settings = @import("settings.zig");

pub const idle_check_seconds = 30;

/// One browser connection listening to one tab.
pub const Subscriber = struct {
    allocator: std.mem.Allocator,
    lock: Io.Mutex = .init,
    ready: Io.Condition = .init,
    queue: std.ArrayList([]const u8) = .empty,
    closed: bool = false,

    pub fn push(self: *Subscriber, io: Io, text: []const u8) void {
        self.lock.lockUncancelable(io);
        defer self.lock.unlock(io);
        if (self.closed) return;
        const copy = self.allocator.dupe(u8, text) catch return;
        self.queue.append(self.allocator, copy) catch {
            self.allocator.free(copy);
            return;
        };
        self.ready.signal(io);
    }

    /// Hands over everything queued; the caller frees each entry.
    pub fn take(self: *Subscriber, into: *std.ArrayList([]const u8), io: Io) !void {
        self.lock.lockUncancelable(io);
        defer self.lock.unlock(io);
        try into.appendSlice(self.allocator, self.queue.items);
        self.queue.clearRetainingCapacity();
    }

    pub fn waitForData(self: *Subscriber, io: Io, timeout: Io.Timeout) bool {
        self.lock.lockUncancelable(io);
        defer self.lock.unlock(io);
        if (self.queue.items.len > 0 or self.closed) return true;
        self.ready.waitTimeout(io, &self.lock, timeout) catch return self.queue.items.len > 0 or self.closed;
        return self.queue.items.len > 0 or self.closed;
    }

    pub fn close(self: *Subscriber, io: Io) void {
        self.lock.lockUncancelable(io);
        self.closed = true;
        self.ready.signal(io);
        self.lock.unlock(io);
    }
};

pub const Tab = struct {
    id: []const u8,
    cwd: []const u8,
    project: bool,
    session_path: ?[]const u8 = null,
    session_name: ?[]const u8 = null,
    running: bool = false,
    closed: bool = false,
    created_ms: i64,
    last_output_ms: i64,
    /// The same two moments on the wall clock. `*_ms` is monotonic and only means something inside
    /// this process; a browser cannot read those.
    created_epoch: i64 = 0,
    last_output_epoch: i64 = 0,
    /// When the current run began and when the last one ended. A tab that has been open for an hour
    /// and started working a second ago must say "0s", not "1h", and a run that finished while
    /// nobody was looking is worth marking.
    run_started_epoch: i64 = 0,
    finished_epoch: i64 = 0,
    /// Set when this chat is a copy: the file it was copied from and the folder that is gone. Both
    /// are read-only facts for the page.
    copied_from: ?[]const u8 = null,
    gone_folder: ?[]const u8 = null,
    worker: ?*Worker = null,
    stderr: child.Tail = .{ .limit = 16 * 1024 },
    subscribers: std.ArrayList(*Subscriber) = .empty,
    lock: Io.Mutex = .init,
};

fn changesSession(kind: []const u8) bool {
    for ([_][]const u8{ "fork", "clone", "new_session", "switch_session", "reload" }) |command| {
        if (std.mem.eql(u8, kind, command)) return true;
    }
    return false;
}

/// Whether a pi marked for a restart can be let go at this moment: between turns, with nothing it
/// was asked still outstanding and nothing borrowed for a session switch. `settled` is the frame
/// that ended a turn, the one point a busy pi can still be replaced - unless a steer is already
/// queued, because then the next turn is on its way.
pub fn readyToReplace(
    marked: bool,
    busy: bool,
    context_pending: bool,
    switching: bool,
    pending: usize,
    settled: bool,
    steer_queued: usize,
) bool {
    return marked and
        !busy and
        !context_pending and
        !switching and
        steer_queued == 0 and
        (settled or pending == 0);
}

/// Whether a thought handed to pi now would still find a turn that collects steering. pi polls its
/// steering queue one last time when a turn ends, so after that the queue has no reader and pi
/// would hold the thought until something else woke it.
pub fn stillSteering(busy: bool, ended: bool) bool {
    return busy and !ended;
}

const Worker = struct {
    process: *child.Child,
    stderr: child.Tail = .{ .limit = 16 * 1024 },
    owner: ?*Tab = null,
    lock: Io.Mutex = .init,
    ready: Io.Condition = .init,
    pending: usize = 0,
    busy: bool = false,
    context_pending: bool = false,
    dead: bool = false,
    switching: bool = false,
    /// Set when this pi is on its way out: it finishes the turn it is in, then the page starts a
    /// fresh one, so a reload never cuts an answer short.
    restart: bool = false,
    /// Messages pi is holding for a later turn, which make a settle the gap between two turns
    /// rather than the end of the work.
    steer_queued: usize = 0,
    /// Set from the moment pi's last turn is over until the run settles, the gap in which a steer
    /// would find no turn left that collects steering.
    ended: bool = false,
    switched: bool = false,
    switch_ok: bool = false,
    switch_cancelled: bool = false,
    target: ?[]const u8 = null,
};

pub const Error = error{ TabNotFound, SpawnFailed, NoWorkdir, OutOfMemory };

/// How much of a chat is copied to read it. A longer chat is cut short there rather than held twice
/// in memory.
const copy_limit = 64 << 20;

pub fn infoOf(tab: *Tab, io: Io) TabInfo {
    tab.lock.lockUncancelable(io);
    defer tab.lock.unlock(io);
    return .{
        .id = tab.id,
        .cwd = tab.cwd,
        .project = tab.project,
        .sessionPath = tab.session_path,
        .sessionName = tab.session_name,
        .running = tab.running,
        .closed = tab.closed,
        .createdMs = tab.created_epoch,
        .lastOutputMs = tab.last_output_epoch,
        .runStartedMs = tab.run_started_epoch,
        .finishedMs = tab.finished_epoch,
        .copiedFrom = tab.copied_from,
        .goneFolder = tab.gone_folder,
    };
}

pub const TabInfo = struct {
    id: []const u8,
    cwd: []const u8,
    project: bool,
    sessionPath: ?[]const u8,
    sessionName: ?[]const u8 = null,
    running: bool,
    closed: bool,
    createdMs: i64,
    lastOutputMs: i64,
    runStartedMs: i64 = 0,
    finishedMs: i64 = 0,
    copiedFrom: ?[]const u8 = null,
    goneFolder: ?[]const u8 = null,
};

/// Whether a tab now points at another session file than the one already remembered. Forking moves
/// a live tab onto a new file, and only a restart that writes that down puts the fork back.
pub fn sessionMoved(before: ?[]const u8, after: []const u8) bool {
    const known = before orelse return true;
    return !std.mem.eql(u8, known, after);
}

const Aged = struct { ms: i64, saved: Saved };

fn byAge(_: void, left: Aged, right: Aged) bool {
    return left.ms < right.ms;
}

/// A crash report has to stay readable in a line-based log: every line of the tail gets indented
/// under the one that carries the timestamp.
fn indented(a: std.mem.Allocator, text: []const u8) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (text) |byte| {
        if (byte == '\n') {
            out.appendSlice(a, "\n      ") catch return out.items;
        } else {
            out.append(a, byte) catch return out.items;
        }
    }
    return out.items;
}

/// What was open the last time piui ran. Tab ids are minted per process and die with it; a working
/// directory and a session file do not.
pub const Saved = struct {
    cwd: []const u8,
    session: ?[]const u8 = null,
};

const Announce = struct {
    type: []const u8 = "piui",
    event: []const u8 = "tab",
    tab: TabInfo,
};

const Running = struct {
    type: []const u8 = "piui",
    event: []const u8 = "running",
    running: bool,
};

const Closed = struct {
    type: []const u8 = "piui",
    event: []const u8 = "closed",
    reason: []const u8 = "pi exited",
    stderr: []const u8,
};

pub const Hub = struct {
    allocator: std.mem.Allocator,
    io: Io,
    group: *Io.Group,
    pi_bin: []const u8,
    scratch_root: []const u8,
    sessions_root: []const u8 = "",
    idle_after_ms: i64,
    /// The home folder and the folder piui was started in, kept because a chat written before paths
    /// were understood may name its throw-away folder relatively.
    home: []const u8 = "",
    here: []const u8 = "",
    /// Where the open tabs get remembered, empty turns that off.
    state_path: []const u8 = "",
    /// What was open when the previous process stopped.
    restored: []const Saved = &.{},

    tabs: std.StringHashMapUnmanaged(*Tab) = .empty,
    lock: Io.Mutex = .init,
    counter: u32 = 0,
    pool_lock: Io.Mutex = .init,
    create_lock: Io.Mutex = .init,
    workers: std.ArrayList(*Worker) = .empty,

    pub fn warm(self: *Hub) void {
        self.pool_lock.lockUncancelable(self.io);
        defer self.pool_lock.unlock(self.io);
        for (self.workers.items) |worker| {
            worker.lock.lockUncancelable(self.io);
            const available =
                !worker.dead and !worker.busy and !worker.context_pending and !worker.restart and (worker.owner == null or worker.pending == 0);
            worker.lock.unlock(self.io);
            if (available) return;
        }
        const process = child.Child.spawn(self.allocator, self.io, .{ .bin = self.pi_bin, .args = &.{ "--mode", "rpc", "--no-session" }, .cwd = self.scratch_root }) catch return;
        const worker = self.allocator.create(Worker) catch {
            process.kill();
            return;
        };
        worker.* = .{ .process = process, .pending = 1 };
        self.workers.append(self.allocator, worker) catch {
            process.kill();
            return;
        };
        self.group.concurrent(self.io, pump, .{ self, worker }) catch {
            worker.dead = true;
            process.kill();
            return;
        };
        self.group.concurrent(self.io, child.drain, .{ self.allocator, self.io, process.stderr, &worker.stderr }) catch process.kill();
        self.write(worker, "{\"type\":\"get_state\",\"id\":\"piui_pool_warm\"}") catch process.kill();
    }

    /// Mark every pi in the pool for a restart: the busy ones go once their turn settles, the ones
    /// already waiting at once, so every chat comes back on a process that read them again.
    pub fn reloadPool(self: *Hub) usize {
        self.pool_lock.lockUncancelable(self.io);
        defer self.pool_lock.unlock(self.io);

        var marked: usize = 0;
        for (self.workers.items) |worker| {
            worker.lock.lockUncancelable(self.io);
            if (worker.dead) {
                worker.lock.unlock(self.io);
                continue;
            }
            worker.restart = true;
            const waiting =
                readyToReplace(true, worker.busy, worker.context_pending, worker.switching, worker.pending, false, worker.steer_queued);
            worker.lock.unlock(self.io);
            marked += 1;
            if (waiting) worker.process.kill();
        }
        return marked;
    }

    pub fn create(self: *Hub, cwd: ?[]const u8, session: ?[]const u8) Error!*Tab {
        self.create_lock.lockUncancelable(self.io);
        defer self.create_lock.unlock(self.io);
        if (session) |path| {
            self.lock.lockUncancelable(self.io);
            defer self.lock.unlock(self.io);
            var iterator = self.tabs.iterator();
            while (iterator.next()) |item| {
                const tab = item.value_ptr.*;
                tab.lock.lockUncancelable(self.io);
                const same = !tab.closed and tab.session_path != null and std.mem.eql(u8, tab.session_path.?, path);
                tab.lock.unlock(self.io);
                if (same) return tab;
            }
        }
        const resolved = self.resolveCwd(cwd) catch return error.NoWorkdir;

        const number = blk: {
            self.lock.lockUncancelable(self.io);
            defer self.lock.unlock(self.io);
            self.counter += 1;
            break :blk self.counter;
        };
        const id = std.fmt.allocPrint(self.allocator, "t{d}", .{number}) catch return error.OutOfMemory;

        const kept_session = if (session) |path|
            self.allocator.dupe(u8, path) catch return error.OutOfMemory
        else
            null;

        const tab = self.allocator.create(Tab) catch return error.OutOfMemory;
        tab.* = .{
            .id = id,
            .cwd = resolved,
            .project = !self.isScratch(resolved),
            .session_path = kept_session,
            .created_ms = json.nowMs(self.io),
            .last_output_ms = json.nowMs(self.io),
            .created_epoch = json.epochMs(self.io),
            .last_output_epoch = json.epochMs(self.io),
        };

        self.pool_lock.lockUncancelable(self.io);
        _ = self.acquire(tab) catch |err| {
            self.pool_lock.unlock(self.io);
            return err;
        };
        self.pool_lock.unlock(self.io);

        self.lock.lockUncancelable(self.io);
        self.tabs.put(self.allocator, id, tab) catch {
            self.lock.unlock(self.io);
            return error.OutOfMemory;
        };
        self.lock.unlock(self.io);

        self.persist();

        self.announce(tab);
        self.bootstrap(tab);
        return tab;
    }

    /// What the browser needs before it replays anything.
    fn announce(self: *Hub, tab: *Tab) void {
        const info = infoOf(tab, self.io);

        const payload = json.encode(self.allocator, Announce{ .tab = info }) catch return;
        defer self.allocator.free(payload);
        self.broadcast(tab, payload);
    }

    /// Pulls the state a fresh transcript is built from. Responses arrive on the same pipe as
    /// everything else, so the browser sees them like live events.
    fn bootstrap(self: *Hub, tab: *Tab) void {
        const commands = [_][]const u8{
            "{\"type\":\"get_state\",\"id\":\"piui_state\"}",
            "{\"type\":\"get_commands\",\"id\":\"piui_commands\"}",
            "{\"type\":\"get_available_models\",\"id\":\"piui_models\"}",
            "{\"type\":\"get_available_thinking_levels\",\"id\":\"piui_thinking\"}",
        };
        for (commands) |command| self.send(tab, command);
    }

    pub fn send(self: *Hub, tab: *Tab, record: []const u8) void {
        self.pool_lock.lockUncancelable(self.io);
        defer self.pool_lock.unlock(self.io);
        const worker = self.acquire(tab) catch {
            self.noteClosed(tab, "pi exited");
            return;
        };
        const parsed = std.json.parseFromSlice(std.json.Value, self.allocator, record, .{}) catch return;
        defer parsed.deinit();
        const kind = if (parsed.value == .object) protocol.string(parsed.value.object, "type") orelse "" else "";
        const queued = std.mem.eql(u8, kind, "steer") or std.mem.eql(u8, kind, "follow_up");
        worker.lock.lockUncancelable(self.io);
        const collecting = stillSteering(worker.busy and !worker.restart, worker.ended);
        const rewriting = queued and !collecting;
        if (!std.mem.eql(u8, kind, "extension_ui_response")) worker.pending += 1;
        if (changesSession(kind)) worker.context_pending = true;
        if (std.mem.eql(u8, kind, "prompt") or queued) worker.busy = true;
        if (queued and !rewriting) worker.steer_queued += 1;
        worker.lock.unlock(self.io);

        const asked = if (rewriting) asPrompt(self.allocator, parsed.value) else null;
        defer if (asked) |text| self.allocator.free(text);
        self.write(worker, asked orelse record) catch {
            worker.process.kill();
            self.noteClosed(tab, "pi exited");
        };
        if (asked != null or std.mem.eql(u8, kind, "prompt")) self.group.concurrent(self.io, Hub.warm, .{self}) catch {};
    }

    /// Rewrites a thought aimed at a turn that is not running into the next thing the chat will do,
    /// because pi would otherwise hold it until something else woke it.
    fn asPrompt(a: std.mem.Allocator, value: std.json.Value) ?[]const u8 {
        if (value != .object) return null;
        var asked = value;
        asked.object.put(a, "type", .{ .string = "prompt" }) catch return null;
        var out: std.Io.Writer.Allocating = .init(a);
        defer out.deinit();
        std.json.Stringify.value(asked, .{}, &out.writer) catch return null;
        return a.dupe(u8, out.written()) catch null;
    }

    fn write(self: *Hub, worker: *Worker, record: []const u8) !void {
        const line = try std.fmt.allocPrint(self.allocator, "{s}\n", .{record});
        defer self.allocator.free(line);
        try worker.process.send(line);
    }

    fn acquire(self: *Hub, tab: *Tab) Error!*Worker {
        if (tab.worker) |worker| {
            worker.lock.lockUncancelable(self.io);
            const valid = !worker.dead and worker.owner == tab;
            worker.lock.unlock(self.io);
            if (valid) return worker;
            tab.worker = null;
        }
        if (tab.session_path) |path| {
            var index = self.workers.items.len;
            while (index > 0) {
                index -= 1;
                const worker = self.workers.items[index];
                worker.lock.lockUncancelable(self.io);
                if (worker.dead or worker.busy or worker.context_pending or worker.pending != 0 or worker.switching or worker.restart) {
                    worker.lock.unlock(self.io);
                    continue;
                }
                const previous = worker.owner;
                if (worker.owner) |old| {
                    old.lock.lockUncancelable(self.io);
                    const persisted = old.session_path != null and !old.running;
                    old.lock.unlock(self.io);
                    if (!persisted) {
                        worker.lock.unlock(self.io);
                        continue;
                    }
                    old.worker = null;
                }
                worker.owner = null;
                worker.switching = true;
                worker.switched = false;
                worker.switch_ok = false;
                worker.switch_cancelled = false;
                worker.target = path;
                worker.lock.unlock(self.io);
                const command = json.encode(self.allocator, .{ .type = "switch_session", .id = "piui_pool_switch", .sessionPath = path }) catch return error.OutOfMemory;
                defer self.allocator.free(command);
                self.write(worker, command) catch {
                    worker.process.kill();
                    continue;
                };
                worker.lock.lockUncancelable(self.io);
                while (!worker.switched and !worker.dead) {
                    worker.ready.waitTimeout(self.io, &worker.lock, .{ .duration = .{ .clock = .awake, .raw = Io.Duration.fromSeconds(15) } }) catch break;
                }
                if (!worker.dead and worker.switched and worker.switch_cancelled) {
                    worker.owner = previous;
                    if (previous) |old| old.worker = worker;
                    worker.switching = false;
                    worker.lock.unlock(self.io);
                    continue;
                }
                if (!worker.dead and worker.switched and worker.switch_ok) {
                    worker.switched = false;
                    worker.switch_ok = false;
                    worker.lock.unlock(self.io);
                    self.write(worker, "{\"type\":\"get_state\",\"id\":\"piui_pool_verify\"}") catch worker.process.kill();
                    worker.lock.lockUncancelable(self.io);
                    while (!worker.switched and !worker.dead) {
                        worker.ready.waitTimeout(self.io, &worker.lock, .{ .duration = .{ .clock = .awake, .raw = Io.Duration.fromSeconds(15) } }) catch break;
                    }
                }
                if (!worker.dead and worker.switched and worker.switch_ok) {
                    worker.owner = tab;
                    worker.switching = false;
                    tab.worker = worker;
                    worker.lock.unlock(self.io);
                    log.info("pi reused {s} pid={?d}", .{ tab.id, worker.process.proc.id });
                    return worker;
                }
                worker.dead = true;
                worker.switching = false;
                worker.lock.unlock(self.io);
                worker.process.kill();
            }
        }
        var args: std.ArrayList([]const u8) = .empty;
        defer args.deinit(self.allocator);
        args.appendSlice(self.allocator, &.{ "--mode", "rpc" }) catch return error.OutOfMemory;
        if (tab.session_path) |path| args.appendSlice(self.allocator, &.{ "--session", path }) catch return error.OutOfMemory;
        if (self.sessions_root.len > 0) {
            const store = sessions.projectDir(self.allocator, self.sessions_root, tab.cwd) catch return error.OutOfMemory;
            Io.Dir.cwd().createDirPath(self.io, store) catch {};
            args.appendSlice(self.allocator, &.{ "--session-dir", store }) catch return error.OutOfMemory;
        }
        const process = child.Child.spawn(self.allocator, self.io, .{ .bin = self.pi_bin, .args = args.items, .cwd = tab.cwd }) catch return error.SpawnFailed;
        errdefer process.kill();
        const worker = self.allocator.create(Worker) catch return error.OutOfMemory;
        worker.* = .{ .process = process, .owner = tab };
        self.workers.append(self.allocator, worker) catch return error.OutOfMemory;
        tab.worker = worker;
        self.group.concurrent(self.io, pump, .{ self, worker }) catch return error.SpawnFailed;
        self.group.concurrent(self.io, child.drain, .{ self.allocator, self.io, process.stderr, &worker.stderr }) catch return error.SpawnFailed;
        log.info("pi started {s} pid={?d} cwd={s}", .{ tab.id, process.proc.id, tab.cwd });
        return worker;
    }

    pub fn get(self: *Hub, id: []const u8) ?*Tab {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return self.tabs.get(id);
    }

    pub fn each(self: *Hub, context: anytype, comptime callback: fn (@TypeOf(context), *Tab) void) void {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        var iterator = self.tabs.iterator();
        while (iterator.next()) |item| callback(context, item.value_ptr.*);
    }

    pub fn subscribe(self: *Hub, tab: *Tab) ?*Subscriber {
        const sub = self.allocator.create(Subscriber) catch return null;
        sub.* = .{ .allocator = self.allocator };

        tab.lock.lockUncancelable(self.io);
        tab.subscribers.append(self.allocator, sub) catch {};
        tab.lock.unlock(self.io);
        return sub;
    }

    pub fn unsubscribe(self: *Hub, tab: *Tab, sub: *Subscriber) void {
        tab.lock.lockUncancelable(self.io);
        for (tab.subscribers.items, 0..) |item, index| {
            if (item != sub) continue;
            _ = tab.subscribers.orderedRemove(index);
            break;
        }
        tab.lock.unlock(self.io);
        sub.close(self.io);
    }

    pub fn broadcast(self: *Hub, tab: *Tab, text: []const u8) void {
        tab.lock.lockUncancelable(self.io);
        defer tab.lock.unlock(self.io);
        for (tab.subscribers.items) |sub| sub.push(self.io, text);
    }

    pub fn close(self: *Hub, tab: *Tab, reason: []const u8) void {
        log.info("closing {s}: {s}", .{ tab.id, reason });

        self.lock.lockUncancelable(self.io);
        _ = self.tabs.remove(tab.id);
        self.lock.unlock(self.io);

        const payload = json.encode(self.allocator, Closed{ .reason = reason, .stderr = "" }) catch return;
        defer self.allocator.free(payload);
        self.markClosed(tab, payload);
        self.release(tab);
        self.persist();
    }

    /// Reads Pi's stdout until the pipe closes, routing as it goes.
    fn pump(hub: *Hub, worker: *Worker) void {
        var retiring = false;
        var buffer: [64 * 1024]u8 = undefined;
        var stream = worker.process.stdout.readerStreaming(hub.io, &buffer);
        var records = framing.Records.init(hub.allocator, &stream.interface);
        defer records.deinit();

        while (records.next()) |maybe_record| {
            const record = maybe_record orelse break;
            defer hub.allocator.free(record);
            var parsed = protocol.parse(hub.allocator, record) catch continue;
            defer parsed.deinit(hub.allocator);
            worker.lock.lockUncancelable(hub.io);
            if (worker.switching) {
                if (parsed.id != null and std.mem.eql(u8, parsed.id.?, "piui_pool_switch")) {
                    worker.switch_ok = parsed.response.success and !parsed.response.cancelled;
                    worker.switch_cancelled = parsed.response.cancelled;
                    worker.switched = true;
                    worker.ready.signal(hub.io);
                } else if (parsed.id != null and std.mem.eql(u8, parsed.id.?, "piui_pool_verify")) {
                    worker.switch_ok = parsed.response.success and parsed.response.session_file != null and worker.target != null and std.mem.eql(u8, parsed.response.session_file.?, worker.target.?);
                    worker.switched = true;
                    worker.ready.signal(hub.io);
                }
                worker.lock.unlock(hub.io);
                continue;
            }
            const owner = worker.owner;
            worker.lock.unlock(hub.io);
            if (owner) |tab| hub.route(tab, record);
            var refresh_context = false;
            worker.lock.lockUncancelable(hub.io);
            if (parsed.kind == .response) {
                worker.pending -|= 1;
                if (changesSession(parsed.response.command)) {
                    if (parsed.response.success and !parsed.response.cancelled) {
                        worker.pending += 1;
                        refresh_context = true;
                    } else worker.context_pending = false;
                }
                if (parsed.id != null and std.mem.eql(u8, parsed.id.?, "piui_pool_context")) worker.context_pending = false;
                if (!parsed.response.success and (std.mem.eql(u8, parsed.response.command, "prompt") or std.mem.eql(u8, parsed.response.command, "steer") or std.mem.eql(u8, parsed.response.command, "follow_up"))) worker.busy = false;
            }
            if (parsed.kind == .agent_start) {
                worker.busy = true;
                worker.ended = false;
                worker.steer_queued = 0;
            }
            if (parsed.kind == .agent_end) worker.ended = !parsed.retrying;
            if (parsed.kind == .agent_settled) {
                worker.busy = false;
                worker.ended = false;
            }
            if (parsed.held) |count| worker.steer_queued = count;
            const settled = parsed.kind == .agent_settled;
            retiring = readyToReplace(
                worker.restart,
                worker.busy,
                worker.context_pending,
                worker.switching,
                worker.pending,
                settled,
                worker.steer_queued,
            );
            worker.lock.unlock(hub.io);
            if (retiring) {
                worker.process.kill();
                break;
            }
            if (refresh_context) hub.write(worker, "{\"type\":\"get_state\",\"id\":\"piui_pool_context\"}") catch worker.process.kill();
        } else |_| {}

        worker.lock.lockUncancelable(hub.io);
        worker.dead = true;
        const owner = worker.owner;
        worker.owner = null;
        worker.ready.signal(hub.io);
        worker.lock.unlock(hub.io);
        if (owner) |tab| hub.noteClosed(tab, if (retiring) "reloaded" else "pi exited");
    }

    /// When the chat last did something. The sidebar sorts settled chats by this, so it moves only
    /// on real activity.
    fn noteActivity(self: *Hub, tab: *Tab) void {
        tab.lock.lockUncancelable(self.io);
        tab.last_output_epoch = json.epochMs(self.io);
        tab.lock.unlock(self.io);
    }

    fn route(self: *Hub, tab: *Tab, record: []const u8) void {
        tab.lock.lockUncancelable(self.io);
        tab.last_output_ms = json.nowMs(self.io);
        tab.lock.unlock(self.io);

        var parsed = protocol.parse(self.allocator, record) catch {
            self.noteActivity(tab);
            self.broadcast(tab, record);
            return;
        };
        defer parsed.deinit(self.allocator);

        if (parsed.kind != .response) self.noteActivity(tab);
        if (parsed.response.session_name) |name| {
            tab.lock.lockUncancelable(self.io);
            self.allocator.free(tab.session_name orelse "");
            tab.session_name = name;
            parsed.response.session_name = null;
            tab.lock.unlock(self.io);
        }

        switch (parsed.kind) {
            .agent_start => self.setRunning(tab, true),
            .agent_settled => self.setRunning(tab, false),
            .session_info_changed => if (parsed.name) |name| {
                tab.lock.lockUncancelable(self.io);
                self.allocator.free(tab.session_name orelse "");
                tab.session_name = name;
                parsed.name = null;
                tab.lock.unlock(self.io);
            },
            .response => if (parsed.response.session_file) |path| {
                var moved = false;
                tab.lock.lockUncancelable(self.io);
                const before = tab.session_path;
                moved = sessionMoved(before, path);
                self.allocator.free(before orelse "");
                tab.session_path = path;
                parsed.response.session_file = null;
                tab.lock.unlock(self.io);

                if (moved) self.persist();
            },
            else => {},
        }

        self.broadcast(tab, record);
    }

    fn setRunning(self: *Hub, tab: *Tab, running: bool) void {
        tab.lock.lockUncancelable(self.io);
        tab.running = running;
        if (running) {
            tab.run_started_epoch = json.epochMs(self.io);
        } else {
            tab.finished_epoch = json.epochMs(self.io);
        }
        tab.lock.unlock(self.io);

        const payload = json.encode(self.allocator, Running{ .running = running }) catch return;
        defer self.allocator.free(payload);
        self.broadcast(tab, payload);
    }

    /// Writes the open tabs next to the config so a restart can put them back. Oldest first, so the
    /// last entry is the one the reader was most recently in.
    fn persist(self: *Hub) void {
        if (self.state_path.len == 0) return;

        var out: Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();

        var open: std.ArrayList(Aged) = .empty;
        defer open.deinit(self.allocator);

        self.lock.lockUncancelable(self.io);
        var iterator = self.tabs.iterator();
        while (iterator.next()) |item| {
            const tab = item.value_ptr.*;
            tab.lock.lockUncancelable(self.io);
            open.append(self.allocator, .{
                .ms = tab.last_output_ms,
                .saved = .{ .cwd = tab.cwd, .session = tab.session_path },
            }) catch {};
            tab.lock.unlock(self.io);
        }
        self.lock.unlock(self.io);

        std.sort.block(Aged, open.items, {}, byAge);

        out.writer.writeAll("[") catch return;
        for (open.items, 0..) |item, at| {
            out.writer.writeAll(if (at == 0) "\n  " else ",\n  ") catch return;
            std.json.Stringify.value(item.saved, .{}, &out.writer) catch return;
        }
        out.writer.writeAll(if (open.items.len == 0) "]\n" else "\n]\n") catch return;

        var atomic = Io.Dir.cwd().createFileAtomic(self.io, self.state_path, .{ .replace = true }) catch return;
        defer atomic.deinit(self.io);
        atomic.file.writeStreamingAll(self.io, out.written()) catch return;
        atomic.replace(self.io) catch return;
    }

    /// The remembered tabs of the previous run. A half-written or foreign file means "nothing to
    /// restore", never a failed start.
    pub fn loadSaved(a: std.mem.Allocator, io: Io, path: []const u8) []const Saved {
        const text = settings.readFile(a, io, path) catch return &.{};
        const parsed = std.json.parseFromSlice([]Saved, a, text, .{ .ignore_unknown_fields = true }) catch
            return &.{};
        return parsed.value;
    }

    fn noteClosed(self: *Hub, tab: *Tab, reason: []const u8) void {
        const tail = if (tab.worker) |worker| worker.stderr.snapshot(self.allocator, self.io) catch "" else tab.stderr.snapshot(self.allocator, self.io) catch "";
        defer if (tail.len > 0) self.allocator.free(tail);

        if (tail.len == 0) {
            log.info("pi exited {s}", .{tab.id});
        } else {
            const report = indented(self.allocator, tail);
            defer self.allocator.free(report);
            log.warn("pi exited {s} stderr:\n      {s}", .{ tab.id, report });
        }

        const payload = json.encode(self.allocator, Closed{ .reason = reason, .stderr = tail }) catch return;
        defer self.allocator.free(payload);
        self.markClosed(tab, payload);
    }

    fn markClosed(self: *Hub, tab: *Tab, payload: []const u8) void {
        tab.lock.lockUncancelable(self.io);
        if (tab.closed) {
            tab.lock.unlock(self.io);
            return;
        }
        tab.closed = true;
        tab.running = false;
        tab.finished_epoch = json.epochMs(self.io);
        const subscribers = self.allocator.dupe(*Subscriber, tab.subscribers.items) catch &.{};
        tab.lock.unlock(self.io);

        for (subscribers) |sub| sub.push(self.io, payload);
        for (subscribers) |sub| sub.close(self.io);
    }

    /// Reclaims idle workers without removing their tabs.
    pub fn reap(self: *Hub, stop: *std.atomic.Value(bool)) void {
        while (!stop.load(.monotonic)) {
            Io.sleep(self.io, Io.Duration.fromSeconds(idle_check_seconds), .awake) catch return;
            self.reapIdle();
        }
    }

    pub fn reapIdle(self: *Hub) void {
        if (self.idle_after_ms <= 0) return;
        const cutoff = json.nowMs(self.io) - self.idle_after_ms;
        var victims: std.ArrayList(*Tab) = .empty;
        defer victims.deinit(self.allocator);
        self.lock.lockUncancelable(self.io);
        var iterator = self.tabs.iterator();
        while (iterator.next()) |item| {
            const tab = item.value_ptr.*;
            tab.lock.lockUncancelable(self.io);
            const idle = !tab.running and !tab.closed and tab.last_output_ms < cutoff;
            tab.lock.unlock(self.io);
            if (idle) victims.append(self.allocator, tab) catch {};
        }
        self.lock.unlock(self.io);
        for (victims.items) |tab| self.release(tab);
    }

    fn release(self: *Hub, tab: *Tab) void {
        self.pool_lock.lockUncancelable(self.io);
        defer self.pool_lock.unlock(self.io);
        const worker = tab.worker orelse return;
        worker.lock.lockUncancelable(self.io);
        defer worker.lock.unlock(self.io);
        if (worker.owner != tab) return;
        if (!tab.closed and (tab.running or worker.busy or worker.context_pending or worker.pending != 0)) return;
        worker.owner = null;
        tab.worker = null;
        if (!worker.busy and !worker.context_pending and worker.pending == 0) {
            var another_idle = false;
            for (self.workers.items) |other| {
                if (other == worker) continue;
                other.lock.lockUncancelable(self.io);
                another_idle = another_idle or (!other.dead and !other.busy and !other.context_pending and other.pending == 0);
                other.lock.unlock(self.io);
            }
            if (!another_idle) return;
        }
        worker.dead = true;
        worker.process.kill();
    }

    /// Say that a chat is being read from a copy of itself, and remember what it was copied from
    /// and which folder is gone. The page needs both to explain itself and to offer putting the
    /// folder back.
    pub fn markCopy(self: *Hub, tab: *Tab, from: []const u8, gone: []const u8) void {
        const original = self.allocator.dupe(u8, from) catch return;
        const missing = self.allocator.dupe(u8, gone) catch return;

        self.lock.lockUncancelable(self.io);
        tab.lock.lockUncancelable(self.io);
        tab.copied_from = original;
        tab.gone_folder = missing;
        tab.lock.unlock(self.io);
        self.lock.unlock(self.io);

        self.announce(tab);
    }

    /// A copy of a stored chat, pointed at a folder that exists.
    pub const Copy = struct { path: []const u8, dir: []const u8 };

    /// Pi turns down a session whose folder is gone, and a folder that was deleted is usually
    /// deleted for a reason.
    pub fn copyForRead(self: *Hub, session: []const u8) Error!Copy {
        const stamp = json.nowMs(self.io);
        const number = blk: {
            self.lock.lockUncancelable(self.io);
            defer self.lock.unlock(self.io);
            self.counter += 1;
            break :blk self.counter;
        };

        const name = std.fmt.allocPrint(self.allocator, "{d}-{d}", .{ stamp, number }) catch return error.OutOfMemory;

        const dir = std.fs.path.join(self.allocator, &.{ self.scratch_root, name }) catch return error.OutOfMemory;
        Io.Dir.cwd().createDirPath(self.io, dir) catch return error.NoWorkdir;

        const store = if (self.sessions_root.len > 0) self.sessions_root else self.scratch_root;
        const copies = std.fs.path.join(self.allocator, &.{ store, "piui-read" }) catch return error.OutOfMemory;
        Io.Dir.cwd().createDirPath(self.io, copies) catch return error.NoWorkdir;

        const copy_name = std.fmt.allocPrint(self.allocator, "{s}.jsonl", .{name}) catch return error.OutOfMemory;
        const path = std.fs.path.join(self.allocator, &.{ copies, copy_name }) catch return error.OutOfMemory;

        var body: std.ArrayList(u8) = .empty;
        errdefer body.deinit(self.allocator);

        var buffer: [16 * 1024]u8 = undefined;
        var file = Io.Dir.cwd().openFile(self.io, session, .{ .allow_directory = false }) catch return error.NoWorkdir;
        defer file.close(self.io);

        var reader = file.readerStreaming(self.io, &buffer);
        var line: std.ArrayList(u8) = .empty;
        var chunk: [8 * 1024]u8 = undefined;
        var read: usize = 0;

        while (read < copy_limit) {
            const got = reader.interface.readSliceShort(&chunk) catch break;
            if (got == 0) break;
            read += got;

            for (chunk[0..got]) |byte| {
                if (byte != '\n') {
                    line.append(self.allocator, byte) catch return error.OutOfMemory;
                    continue;
                }
                self.copyLine(&body, line.items, dir) catch return error.OutOfMemory;
                line.clearRetainingCapacity();
            }
        }
        if (line.items.len > 0) self.copyLine(&body, line.items, dir) catch return error.OutOfMemory;

        Io.Dir.cwd().writeFile(self.io, .{ .sub_path = path, .data = body.items }) catch |err| {
            log.warn("could not copy {s}: {t}", .{ session, err });
            return error.NoWorkdir;
        };
        log.info("chat copied to read, its folder is gone: {s} → {s}", .{ session, path });
        return .{ .path = path, .dir = dir };
    }

    /// One line of a session file. Only the header remembers a folder, and only that one field is
    /// touched; every other line goes over as it stands.
    fn copyLine(self: *Hub, body: *std.ArrayList(u8), line: []const u8, dir: []const u8) !void {
        var parsed = std.json.parseFromSlice(std.json.Value, self.allocator, line, .{}) catch
            return body.appendSlice(self.allocator, line);
        defer parsed.deinit();

        if (parsed.value != .object or
            !std.mem.eql(u8, protocol.string(parsed.value.object, "type") orelse "", "session"))
        {
            body.appendSlice(self.allocator, line) catch return error.OutOfMemory;
            try body.append(self.allocator, '\n');
            return;
        }

        parsed.value.object.put(self.allocator, "cwd", .{ .string = dir }) catch return error.OutOfMemory;
        const text = std.json.Stringify.valueAlloc(self.allocator, parsed.value, .{}) catch return error.OutOfMemory;
        body.appendSlice(self.allocator, text) catch return error.OutOfMemory;
        try body.append(self.allocator, '\n');
    }

    /// Every folder piui minted under its own scratch root, deleted, and the root itself kept. A
    /// folder that will not go away is passed over, so one stuck mount does not hold up the rest.
    pub fn clearScratch(self: *Hub) usize {
        if (self.scratch_root.len < 2) return 0;
        var dir = Io.Dir.cwd().openDir(self.io, self.scratch_root, .{ .iterate = true }) catch return 0;
        defer dir.close(self.io);

        const Item = struct { name: []const u8, folder: bool };
        var names: std.ArrayListUnmanaged(Item) = .empty;
        defer names.deinit(self.allocator);

        var iterator = dir.iterate();
        while (true) {
            const item = iterator.next(self.io) catch break;
            const entry = item orelse break;
            if (entry.name.len == 0) continue;
            const kept = Item{
                .name = self.allocator.dupe(u8, entry.name) catch break,
                .folder = entry.kind == .directory,
            };
            names.append(self.allocator, kept) catch break;
        }

        var removed: usize = 0;
        for (names.items) |item| {
            if (item.folder) {
                dir.deleteTree(self.io, item.name) catch continue;
            } else {
                dir.deleteFile(self.io, item.name) catch continue;
            }
            removed += 1;
        }
        return removed;
    }

    /// The chats Pi kept for folders piui minted are deleted with the folders, so the session list
    /// does not fill with chats that have nothing on disk left to read.
    pub fn clearScratchSessions(self: *Hub) usize {
        var picked: std.ArrayListUnmanaged([]const u8) = .empty;
        defer picked.deinit(self.allocator);
        for (self.chats() orelse return 0) |entry| {
            if (!self.mints(entry.cwd orelse "")) continue;
            picked.append(self.allocator, entry.path) catch break;
        }
        return self.dropFiles(picked.items);
    }

    /// Every stored chat of one folder, which is what the broom beside a project in the list asks
    /// for; the folder the chats happened in is not touched, nor anything inside it.
    pub fn dropProject(self: *Hub, bucket: []const u8) usize {
        var picked: std.ArrayListUnmanaged([]const u8) = .empty;
        defer picked.deinit(self.allocator);
        for (self.chats() orelse return 0) |entry| {
            if (!bucketed(entry.cwd orelse "", bucket)) continue;
            picked.append(self.allocator, entry.path) catch break;
        }
        return self.dropFiles(picked.items);
    }

    /// One stored chat named by the path the list handed out, refusing anything outside Pi's own
    /// session folder.
    pub fn dropSession(self: *Hub, path: []const u8) bool {
        if (!stored(self.sessions_root, path)) return false;
        const one = [_][]const u8{path};
        return self.dropFiles(&one) > 0;
    }

    fn chats(self: *Hub) ?[]sessions.Entry {
        if (self.sessions_root.len < 2) return null;
        const index = sessions.Index{ .allocator = self.allocator, .io = self.io, .root = self.sessions_root };
        return index.list(null) catch null;
    }

    /// Deletes the given session files, then takes away the folder Pi made for a project once its
    /// last chat went with them.
    fn dropFiles(self: *Hub, paths: []const []const u8) usize {
        var emptied: std.ArrayListUnmanaged([]const u8) = .empty;
        defer emptied.deinit(self.allocator);

        var removed: usize = 0;
        for (paths) |path| {
            Io.Dir.cwd().deleteFile(self.io, path) catch continue;
            removed += 1;

            const parent = std.fs.path.dirname(path) orelse continue;
            if (listed(emptied.items, parent)) continue;
            emptied.append(self.allocator, parent) catch continue;
        }

        for (emptied.items) |folder| {
            if (folderEmpty(self, folder)) Io.Dir.cwd().deleteTree(self.io, folder) catch {};
        }
        return removed;
    }

    /// True for the throw-away directories a chat with no project runs in.
    pub fn isScratch(self: *Hub, cwd: []const u8) bool {
        return self.scratch_root.len > 0 and std.mem.startsWith(u8, cwd, self.scratch_root);
    }

    /// Whether a workdir is one of the throw-away folders, read the way it was written when the chat
    /// began: a chat from before piui understood `~` still names its folder relatively.
    fn mints(self: *Hub, cwd: []const u8) bool {
        if (self.isScratch(cwd)) return true;
        if (minted(cwd)) return true;
        if (self.home.len == 0) return false;
        const healed = dirs.wanted(self.allocator, self.home, self.here, cwd) catch return false;
        return self.isScratch(healed);
    }

    fn resolveCwd(self: *Hub, cwd: ?[]const u8) ![]u8 {
        if (cwd) |path| {
            if (path.len == 0) return error.NoWorkdir;
            var dir = Io.Dir.cwd().openFile(self.io, path, .{}) catch return error.NoWorkdir;
            dir.close(self.io);
            return self.allocator.dupe(u8, path);
        }

        const stamp = json.nowMs(self.io);
        const number = blk: {
            self.lock.lockUncancelable(self.io);
            defer self.lock.unlock(self.io);
            self.counter += 1;
            break :blk self.counter;
        };
        const name = std.fmt.allocPrint(self.allocator, "{d}-{d}", .{ stamp, number }) catch return error.OutOfMemory;
        const path = std.fs.path.join(self.allocator, &.{ self.scratch_root, name }) catch return error.OutOfMemory;
        Io.Dir.cwd().createDirPath(self.io, path) catch return error.NoWorkdir;
        return path;
    }
};

/// A folder piui minted for a chat with no project, in any layout it has written so far: a
/// directory named scratch, or a numbered run inside one.
fn minted(path: []const u8) bool {
    const base = std.fs.path.basename(path);
    if (!std.mem.eql(u8, std.fs.path.basename(std.fs.path.dirname(path) orelse ""), "scratch")) {
        return std.mem.eql(u8, base, "scratch");
    }
    var i: usize = 0;
    while (i < base.len and std.ascii.isDigit(base[i])) i += 1;
    if (i == 0 or i == base.len or base[i] != '-') return false;
    while (i < base.len) : (i += 1) {
        if (base[i] != '-' and !std.ascii.isDigit(base[i])) return false;
    }
    return true;
}

/// Whether a chat belongs to the group the list shows a folder under: the folder itself, or, for a
/// group of throw-away folders, anything beneath it.
pub fn bucketed(cwd: []const u8, bucket: []const u8) bool {
    if (bucket.len == 0) return cwd.len == 0;
    if (std.mem.eql(u8, cwd, bucket)) return true;
    return std.mem.endsWith(u8, bucket, "/scratch") and
        std.mem.startsWith(u8, cwd, bucket) and
        cwd.len > bucket.len and
        cwd[bucket.len] == '/';
}

/// Whether a path names a file inside Pi's own session folder, and nothing a request made up.
fn stored(root: []const u8, path: []const u8) bool {
    return root.len > 1 and std.mem.startsWith(u8, path, root) and
        path.len > root.len and path[root.len] == '/' and std.mem.indexOf(u8, path, "..") == null;
}

fn listed(list: []const []const u8, path: []const u8) bool {
    for (list) |one| if (std.mem.eql(u8, one, path)) return true;
    return false;
}

fn folderEmpty(self: *Hub, folder: []const u8) bool {
    var dir = Io.Dir.cwd().openDir(self.io, folder, .{ .iterate = true }) catch return false;
    defer dir.close(self.io);

    var walker = dir.iterate();
    return (walker.next(self.io) catch null) == null;
}
