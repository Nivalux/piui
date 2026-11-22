const std = @import("std");
const Io = std.Io;
const child = @import("child.zig");
const framing = @import("framing.zig");
const protocol = @import("protocol.zig");
const json = @import("json.zig");
const log = @import("log.zig");
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
    /// The same two moments on the wall clock. `*_ms` is monotonic and only
    /// means something inside this process; a browser cannot read those.
    created_epoch: i64 = 0,
    last_output_epoch: i64 = 0,
    /// When the current run began and when the last one ended. A tab that has
    /// been open for an hour and started working a second ago must say "0s", not
    /// "1h", and a run that finished while nobody was looking is worth marking.
    run_started_epoch: i64 = 0,
    finished_epoch: i64 = 0,
    /// Set when this chat is a copy: the file it was copied from and the folder
    /// that is gone. Both are read-only facts for the page.
    copied_from: ?[]const u8 = null,
    gone_folder: ?[]const u8 = null,
    process: *child.Child,
    stderr: child.Tail = .{ .limit = 16 * 1024 },
    subscribers: std.ArrayList(*Subscriber) = .empty,
    lock: Io.Mutex = .init,
};

pub const Error = error{ TabNotFound, SpawnFailed, NoWorkdir, OutOfMemory };

/// How much of a chat is copied to read it. A longer chat is cut short there
/// rather than held twice in memory.
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

const Aged = struct { ms: i64, saved: Saved };

fn byAge(_: void, left: Aged, right: Aged) bool {
    return left.ms < right.ms;
}

/// A crash report has to stay readable in a line-based log: every line of the
/// tail gets indented under the one that carries the timestamp.
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

/// What was open the last time piui ran. Tab ids are minted per process and
/// die with it; a working directory and a session file do not.
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
    /// Where the open tabs get remembered, empty turns that off.
    state_path: []const u8 = "",
    /// What was open when the previous process stopped.
    restored: []const Saved = &.{},

    tabs: std.StringHashMapUnmanaged(*Tab) = .empty,
    lock: Io.Mutex = .init,
    counter: u32 = 0,

    pub fn create(self: *Hub, cwd: ?[]const u8, session: ?[]const u8) Error!*Tab {
        const resolved = self.resolveCwd(cwd) catch return error.NoWorkdir;

        const number = blk: {
            self.lock.lockUncancelable(self.io);
            defer self.lock.unlock(self.io);
            self.counter += 1;
            break :blk self.counter;
        };
        const id = std.fmt.allocPrint(self.allocator, "t{d}", .{number}) catch return error.OutOfMemory;

        var args: std.ArrayList([]const u8) = .empty;
        args.append(self.allocator, "--mode") catch return error.OutOfMemory;
        args.append(self.allocator, "rpc") catch return error.OutOfMemory;
        if (session) |path| {
            args.append(self.allocator, "--session") catch return error.OutOfMemory;
            args.append(self.allocator, path) catch return error.OutOfMemory;
        }
        if (self.sessions_root.len > 0) {
            args.append(self.allocator, "--session-dir") catch return error.OutOfMemory;
            args.append(self.allocator, self.sessions_root) catch return error.OutOfMemory;
        }

        const process = child.Child.spawn(self.allocator, self.io, .{
            .bin = self.pi_bin,
            .args = args.items,
            .cwd = resolved,
        }) catch |err| {
            self.allocator.free(resolved);
            return switch (err) {
                else => error.SpawnFailed,
            };
        };

        // The caller's copy lives in the request's arena and dies with it, so
        // the tab has to hold its own.
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
            .process = process,
        };

        self.lock.lockUncancelable(self.io);
        self.tabs.put(self.allocator, id, tab) catch {
            self.lock.unlock(self.io);
            return error.OutOfMemory;
        };
        self.lock.unlock(self.io);

        self.group.concurrent(self.io, pump, .{ self, tab }) catch {
            self.close(tab, "reader failed to start");
            return error.SpawnFailed;
        };

        if (session) |path| {
            log.info("pi started {s} pid={?d} cwd={s} session={s}", .{ id, process.proc.id, resolved, path });
        } else {
            log.info("pi started {s} pid={?d} cwd={s}", .{ id, process.proc.id, resolved });
        }
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

    /// Pulls the state a fresh transcript is built from. Responses arrive on the
    /// same pipe as everything else, so the browser sees them like live events.
    fn bootstrap(self: *Hub, tab: *Tab) void {
        const commands = [_][]const u8{
            "{\"type\":\"get_state\",\"id\":\"piui_state\"}",
            "{\"type\":\"get_messages\",\"id\":\"piui_messages\"}",
            "{\"type\":\"get_commands\",\"id\":\"piui_commands\"}",
            "{\"type\":\"get_available_models\",\"id\":\"piui_models\"}",
            "{\"type\":\"get_available_thinking_levels\",\"id\":\"piui_thinking\"}",
        };
        for (commands) |command| self.send(tab, command);
    }

    pub fn send(self: *Hub, tab: *Tab, record: []const u8) void {
        var line: std.ArrayList(u8) = .empty;
        defer line.deinit(self.allocator);
        line.appendSlice(self.allocator, record) catch return;
        line.append(self.allocator, '\n') catch return;
        tab.process.send(line.items) catch self.noteClosed(tab);
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

        const payload = json.encode(self.allocator, Closed{ .reason = reason, .stderr = "" }) catch {
            tab.process.kill();
            return;
        };
        defer self.allocator.free(payload);
        self.markClosed(tab, payload);
        tab.process.kill();
        self.persist();
    }

    /// Reads Pi's stdout until the pipe closes, routing as it goes.
    fn pump(hub: *Hub, tab: *Tab) void {
        var buffer: [64 * 1024]u8 = undefined;
        var stream = tab.process.stdout.readerStreaming(hub.io, &buffer);
        var records = framing.Records.init(hub.allocator, &stream.interface);
        defer records.deinit();

        while (records.next()) |maybe_record| {
            const record = maybe_record orelse break;
            defer hub.allocator.free(record);
            hub.route(tab, record);
        } else |_| {}

        hub.noteClosed(tab);
    }

    /// When the chat last did something. The sidebar sorts settled chats by
    /// this, so it moves only on real activity.
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

        // A reply to something the browser asked for is not activity. Stamping
        // it would let clicking back and forth between two settled chats keep
        // trading their places in the list.
        if (parsed.kind != .response) self.noteActivity(tab);

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
                var fresh = false;
                tab.lock.lockUncancelable(self.io);
                const known = tab.session_path != null;
                self.allocator.free(tab.session_path orelse "");
                tab.session_path = path;
                parsed.response.session_file = null;
                tab.lock.unlock(self.io);

                // A chat only becomes resumable once it has a file on disk, so
                // that is the moment worth writing down.
                fresh = !known;
                if (fresh) self.persist();
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

    /// Writes the open tabs next to the config so a restart can put them back.
    /// Oldest first, so the last entry is the one the reader was most recently in.
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
            if (tab.closed) continue;
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

    /// The remembered tabs of the previous run. A half-written or foreign file
    /// means "nothing to restore", never a failed start.
    pub fn loadSaved(a: std.mem.Allocator, io: Io, path: []const u8) []const Saved {
        const text = settings.readFile(a, io, path) catch return &.{};
        const parsed = std.json.parseFromSlice([]Saved, a, text, .{ .ignore_unknown_fields = true }) catch
            return &.{};
        return parsed.value;
    }

    fn noteClosed(self: *Hub, tab: *Tab) void {
        const tail = tab.stderr.snapshot(self.allocator, self.io) catch "";
        defer if (tail.len > 0) self.allocator.free(tail);

        if (tail.len == 0) {
            log.info("pi exited {s}", .{tab.id});
        } else {
            const report = indented(self.allocator, tail);
            defer self.allocator.free(report);
            log.warn("pi exited {s} stderr:\n      {s}", .{ tab.id, report });
        }

        const payload = json.encode(self.allocator, Closed{ .stderr = tail }) catch return;
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

    /// Reaps tabs whose pipe has been quiet for `idle_after_ms`.
    pub fn reap(self: *Hub, stop: *std.atomic.Value(bool)) void {
        while (!stop.load(.monotonic)) {
            Io.sleep(self.io, Io.Duration.fromSeconds(idle_check_seconds), .awake) catch return;
            if (self.idle_after_ms <= 0) continue;

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

            for (victims.items) |tab| self.close(tab, "idle timeout");
        }
    }

    /// Say that a chat is being read from a copy of itself, and remember what
    /// it was copied from and which folder is gone. The page needs both to
    /// explain itself and to offer putting the folder back.
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

    /// Pi turns down a session whose folder is gone, and a folder that was
    /// deleted is usually deleted for a reason. So the chat is copied into the
    /// scratch root with only its remembered folder pointed somewhere new, and
    /// Pi reads that. The original file is left exactly as it was and nothing
    /// appears where the deleted folder used to be.
    pub fn copyForRead(self: *Hub, session: []const u8) Error!Copy {
        const stamp = json.nowMs(self.io);
        const number = blk: {
            self.lock.lockUncancelable(self.io);
            defer self.lock.unlock(self.io);
            self.counter += 1;
            break :blk self.counter;
        };

        const name = std.fmt.allocPrint(self.allocator, "{d}-{d}", .{ stamp, number }) catch return error.OutOfMemory;

        // Two places, because Pi wants two things: a folder that exists to work
        // in, and a chat file inside its own store, which is the only place it
        // will read a session from.
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

    /// One line of a session file. Only the header remembers a folder, and only
    /// that one field is touched; every other line goes over as it stands.
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

    /// True for the throw-away directories a chat with no project runs in.
    pub fn isScratch(self: *Hub, cwd: []const u8) bool {
        return self.scratch_root.len > 0 and std.mem.startsWith(u8, cwd, self.scratch_root);
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
