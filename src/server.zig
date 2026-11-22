const std = @import("std");
const Io = std.Io;
const hub = @import("hub.zig");
const sessions = @import("sessions.zig");
const settings = @import("settings.zig");
const git = @import("git.zig");
const dirs = @import("dirs.zig");
const files = @import("files.zig");
const json = @import("json.zig");
const assets = @import("assets.zig");
const protocol = @import("protocol.zig");
const shells = @import("shells.zig");
const auth = @import("auth.zig");
const log = @import("log.zig");

pub const Options = struct {
    allocator: std.mem.Allocator,
    io: Io,
    hub: *hub.Hub,
    shells: *shells.Pool,
    index: sessions.Index,
    config: *settings.Settings,
    token: auth.Token,
    web_root: ?[]const u8 = null,
};

pub const max_body = 1 << 20;

const heartbeat = Io.Timeout{ .duration = .{
    .raw = Io.Duration.fromMilliseconds(15_000),
    .clock = .awake,
} };

pub const Server = struct {
    options: Options,

    pub fn serve(self: *Server, connection: std.Io.net.Stream) void {
        const io = self.options.io;

        var in_buffer: [16 * 1024]u8 = undefined;
        var out_buffer: [64 * 1024]u8 = undefined;
        var reader = connection.reader(io, &in_buffer);
        var writer = connection.writer(io, &out_buffer);

        var http_server = std.http.Server.init(&reader.interface, &writer.interface);
        while (true) {
            var request = http_server.receiveHead() catch return;

            var arena = std.heap.ArenaAllocator.init(self.options.allocator);
            defer arena.deinit();
            log.begin(@tagName(request.head.method), request.head.target);
            self.route(&request, arena.allocator()) catch return;
        }
    }

    fn route(self: *Server, request: *std.http.Server.Request, a: std.mem.Allocator) !void {
        const target = request.head.target;
        const path = if (std.mem.indexOfScalar(u8, target, '?')) |cut| target[0..cut] else target;

        if (std.mem.startsWith(u8, path, "/api/")) return self.api(request, path, a);
        if (request.head.method != .GET) return self.text(request, .method_not_allowed, "GET only");
        return self.staticFile(request, path, a);
    }

    fn api(self: *Server, request: *std.http.Server.Request, path: []const u8, a: std.mem.Allocator) !void {
        const io = self.options.io;
        const target = request.head.target;

        if (std.mem.eql(u8, path, "/api/health")) {
            const signed_in = self.signedIn(request);
            const build = "\"build\":\"" ++ assets.build ++ "\"";
            return self.sendJson(request, .ok, if (signed_in)
                "{\"ok\":true,\"signedIn\":true," ++ build ++ "}"
            else
                "{\"ok\":true,\"signedIn\":false," ++ build ++ "}");
        }

        if (std.mem.eql(u8, path, "/api/login")) return self.login(request, a);

        // Everything past here can start a pi, read a session or write the
        // config, so it needs the cookie the login handed out.
        if (!self.signedIn(request)) {
            return self.sendJson(request, .unauthorized, "{\"error\":\"token required\"}");
        }

        if (std.mem.eql(u8, path, "/api/logout")) return self.logout(request, a);

        if (std.mem.eql(u8, path, "/api/tabs")) {
            var collector = Collector{ .allocator = a, .list = .empty, .io = io };
            self.options.hub.each(&collector, collect);

            const payload = json.encode(a, collector.list.items) catch return self.text(request, .internal_server_error, "encode");
            return self.respond(request, .ok, "application/json", payload);
        }

        if (std.mem.eql(u8, path, "/api/tab")) {
            if (request.head.method == .DELETE) {
                const tab = self.tabFor(request, a) orelse return self.text(request, .not_found, "no such tab");
                self.options.shells.closeTab(tab.id);
                self.options.hub.close(tab, "closed by user");
                return self.sendJson(request, .ok, "{\"ok\":true}");
            }
            return self.openTab(request, a);
        }

        if (std.mem.eql(u8, path, "/api/events")) {
            const tab = self.tabFor(request, a) orelse return self.text(request, .not_found, "no such tab");
            return self.events(request, tab);
        }

        // The terminal windows. The list is what a page opens tabs for when it
        // loads; everything else addresses one shell by its number.
        if (std.mem.eql(u8, path, "/api/pty")) {
            if (request.head.method == .GET) {
                const payload = json.encode(a, ShellList{ .shells = self.options.shells.alive(a) }) catch
                    return self.text(request, .internal_server_error, "encode");
                return self.respond(request, .ok, "application/json", payload);
            }
            if (request.head.method == .DELETE) {
                const shell = self.shellFor(request, a) orelse return self.text(request, .not_found, "no such shell");
                self.options.shells.close(shell, "closed by user");
                return self.sendJson(request, .ok, "{\"ok\":true}");
            }
            return self.openShell(request, a);
        }

        if (std.mem.eql(u8, path, "/api/pty/write")) {
            const shell = self.shellFor(request, a) orelse return self.text(request, .not_found, "no such shell");
            return self.shellWrite(request, shell, a);
        }

        if (std.mem.eql(u8, path, "/api/pty/resize")) {
            const shell = self.shellFor(request, a) orelse return self.text(request, .not_found, "no such shell");
            return self.shellResize(request, shell, a);
        }

        if (std.mem.eql(u8, path, "/api/pty/events")) {
            const shell = self.shellFor(request, a) orelse return self.text(request, .not_found, "no such shell");
            return self.shellEvents(request, shell);
        }

        if (std.mem.eql(u8, path, "/api/cmd")) {
            const tab = self.tabFor(request, a) orelse return self.text(request, .not_found, "no such tab");
            const body = self.readBody(request, a) catch return self.text(request, .bad_request, "body");

            const id = std.fmt.allocPrint(a, "c{d}", .{json.nowMs(io)}) catch
                return self.text(request, .internal_server_error, "oom");

            const record = protocol.ensureId(a, body, id) catch
                return self.text(request, .bad_request, "not a json object");

            self.options.hub.send(tab, record);
            return self.sendJson(request, .accepted, "{\"ok\":true,\"state\":\"queued\"}");
        }

        if (std.mem.eql(u8, path, "/api/restore")) {
            const payload = json.encode(a, self.options.hub.restored) catch
                return self.text(request, .internal_server_error, "encode");
            return self.respond(request, .ok, "application/json", payload);
        }

        if (std.mem.eql(u8, path, "/api/sessions")) {
            // A scratch chat has no project worth filtering to: asking for its
            // sessions means asking for the newest there is anywhere.
            const wanted = if (query(a, target, "cwd")) |cwd|
                (if (self.options.hub.isScratch(cwd)) null else cwd)
            else
                null;
            const list = self.options.index.list(wanted) catch &.{};

            const payload = json.encode(a, list) catch return self.text(request, .internal_server_error, "encode");
            return self.respond(request, .ok, "application/json", payload);
        }

        if (std.mem.eql(u8, path, "/api/dirs")) {
            const listing = dirs.list(a, io, query(a, target, "path"), dirs.limit) catch |err| switch (err) {
                error.NotFound => return self.sendJson(request, .not_found, "{\"error\":\"no such folder\"}"),
                error.NotDirectory => return self.sendJson(request, .conflict, "{\"error\":\"that is a file\"}"),
                error.OutOfMemory => return self.text(request, .internal_server_error, "oom"),
            };
            const payload = json.encode(a, listing) catch
                return self.text(request, .internal_server_error, "encode");
            return self.respond(request, .ok, "application/json", payload);
        }

        if (std.mem.eql(u8, path, "/api/git/status")) {
            const tab = self.tabFor(request, a) orelse return self.text(request, .not_found, "no such tab");
            const status = git.status(a, io, tab.cwd, self.baseFor(request, tab, a));
            const payload = json.encode(a, status) catch return self.text(request, .internal_server_error, "encode");
            return self.respond(request, .ok, "application/json", payload);
        }

        if (std.mem.eql(u8, path, "/api/git/diff")) {
            const tab = self.tabFor(request, a) orelse return self.text(request, .not_found, "no such tab");
            const body = git.diff(a, io, tab.cwd, self.baseFor(request, tab, a), query(a, target, "path")) catch |err| switch (err) {
                error.NotRepository => return self.text(request, .conflict, git.not_a_repository),
                error.TooLarge => return self.text(request, .payload_too_large, "diff too large"),
                else => return self.text(request, .internal_server_error, "git diff failed"),
            };
            return self.respond(request, .ok, "text/plain; charset=utf-8", body);
        }

        if (std.mem.eql(u8, path, "/api/files")) {
            const tab = self.tabFor(request, a) orelse return self.text(request, .not_found, "no such tab");
            const listing = files.list(a, io, tab.cwd, files.max_list) catch
                return self.text(request, .not_found, "cannot read this folder");
            const payload = json.encode(a, listing) catch return self.text(request, .internal_server_error, "encode");
            return self.respond(request, .ok, "application/json", payload);
        }

        if (std.mem.eql(u8, path, "/api/file")) {
            const tab = self.tabFor(request, a) orelse return self.text(request, .not_found, "no such tab");
            const wanted = query(a, target, "path") orelse return self.text(request, .bad_request, "no path given");
            const content = files.read(a, io, tab.cwd, wanted) catch |err| return switch (err) {
                error.Outside => self.text(request, .forbidden, "outside this project"),
                error.NotFile => self.text(request, .conflict, "that is a folder"),
                error.NotFound => self.text(request, .not_found, "no such file"),
                error.OutOfMemory => self.text(request, .internal_server_error, "oom"),
            };
            const payload = json.encode(a, content) catch return self.text(request, .internal_server_error, "encode");
            return self.respond(request, .ok, "application/json", payload);
        }

        if (std.mem.eql(u8, path, "/api/settings")) return self.settings(request, a);

        return self.text(request, .not_found, "unknown endpoint");
    }

    fn signedIn(self: *Server, request: *std.http.Server.Request) bool {
        const given = auth.cookieValue(request.head_buffer, auth.cookie_name) orelse return false;
        return self.options.token.matches(given);
    }

    fn login(self: *Server, request: *std.http.Server.Request, a: std.mem.Allocator) !void {
        if (request.head.method != .POST) return self.text(request, .method_not_allowed, "POST only");

        const body = self.readBody(request, a) catch return self.text(request, .bad_request, "body");
        var parsed = std.json.parseFromSlice(std.json.Value, a, body, .{}) catch
            return self.denied(request, a);
        defer parsed.deinit();

        if (parsed.value != .object) return self.denied(request, a);
        const given = protocol.string(parsed.value.object, "token") orelse return self.denied(request, a);
        if (!self.options.token.matches(given)) return self.denied(request, a);

        const cookie = self.options.token.setCookie(a) catch
            return self.text(request, .internal_server_error, "oom");
        return self.respondWith(
            request,
            .ok,
            "application/json",
            "{\"ok\":true}",
            &.{.{ .name = "set-cookie", .value = cookie }},
        );
    }

    fn logout(self: *Server, request: *std.http.Server.Request, a: std.mem.Allocator) !void {
        const cookie = auth.clearCookie(a) catch return self.text(request, .internal_server_error, "oom");
        return self.respondWith(
            request,
            .ok,
            "application/json",
            "{\"ok\":true}",
            &.{.{ .name = "set-cookie", .value = cookie }},
        );
    }

    fn denied(self: *Server, request: *std.http.Server.Request, a: std.mem.Allocator) !void {
        _ = a;
        return self.sendJson(request, .unauthorized, "{\"error\":\"wrong token\"}");
    }

    /// Starts a chat. A resumed session knows the project it began in, and a
    /// chat taken from that list belongs there: leaving it in a fresh scratch
    /// folder would make a project chat look like it has no project. A project
    /// that has since been deleted still gets its chat, in the scratch root.
    /// Open a chat, and say what it took. A chat whose folder is gone comes back
    /// as a copy rather than a failure, so the page is told which of the two it
    /// is looking at.
    const Opened = struct { tab: *hub.Tab, copiedFrom: ?[]const u8 = null, goneFolder: ?[]const u8 = null };

    fn start(self: *Server, cwd: ?[]const u8, session: ?[]const u8, recreate: bool) hub.Error!Opened {
        // A scratch folder is not a project, so it does not outrank the one the
        // session remembers. That is also how a chat put back after a restart
        // finds its project again: what was saved next to the session was
        // wherever Pi happened to be running.
        var given = cwd;
        if (session != null and self.options.hub.isScratch(cwd orelse "")) given = null;

        var remembered: ?[]const u8 = null;
        if (given == null) {
            if (session) |path| remembered = self.options.index.cwdOf(path);
        }

        var where = given orelse remembered;
        var read = session;
        var copied: ?[]const u8 = null;

        // A folder is only ever created because a person asked for it. The one a
        // chat remembers is usually gone for a reason, so the chat is copied to
        // the scratch root and read from there until someone asks for the folder
        // back.
        if (where) |path| {
            if (!self.exists(path)) {
                if (session == null) return error.NoWorkdir;
                if (recreate) {
                    Io.Dir.cwd().createDirPath(self.options.io, path) catch return error.NoWorkdir;
                    log.info("folder made again by hand: {s}", .{path});
                } else {
                    const copy = self.options.hub.copyForRead(session.?) catch return error.NoWorkdir;
                    where = copy.dir;
                    read = copy.path;
                    copied = path;
                }
            }
        }

        const tab = self.options.hub.create(where, read) catch |err| {
            // The copy was made in a folder of its own, so a chat that still
            // cannot start has no excuse left for failing.
            if (err == error.NoWorkdir and copied != null) return error.NoWorkdir;
            return err;
        };
        return .{ .tab = tab, .copiedFrom = if (copied != null) session else null, .goneFolder = copied };
    }

    fn exists(self: *Server, path: []const u8) bool {
        Io.Dir.access(.cwd(), self.options.io, path, .{}) catch return false;
        return true;
    }

    fn openTab(self: *Server, request: *std.http.Server.Request, a: std.mem.Allocator) !void {
        var cwd: ?[]const u8 = null;
        var session: ?[]const u8 = null;
        var recreate = false;

        if (self.readBody(request, a)) |body| {
            if (body.len > 0) {
                var parsed = std.json.parseFromSlice(std.json.Value, a, body, .{}) catch
                    return self.text(request, .bad_request, "not json");
                defer parsed.deinit();
                if (parsed.value == .object) {
                    // The parse dies with this block, so whatever is used after
                    // it is copied out first.
                    if (protocol.string(parsed.value.object, "cwd")) |given| {
                        cwd = a.dupe(u8, given) catch return self.text(request, .internal_server_error, "out of memory");
                    }
                    if (protocol.string(parsed.value.object, "session")) |name| {
                        session = a.dupe(u8, name) catch return self.text(request, .internal_server_error, "out of memory");
                    }
                    recreate = protocol.flag(parsed.value.object, "recreate");
                }
            }
        } else |_| {}

        if (session) |name| {
            session = if (std.mem.endsWith(u8, name, ".jsonl"))
                (if (self.insideStore(name)) name else return self.text(request, .bad_request, "session outside the store"))
            else
                self.options.index.resolve(name) catch
                    return self.text(request, .bad_request, "unknown session");
        }

        const opened = self.start(cwd, session, recreate) catch |err| switch (err) {
            error.NoWorkdir => return self.text(request, .bad_request, "that folder is gone"),
            else => return self.text(request, .internal_server_error, "cannot start pi"),
        };

        if (opened.copiedFrom) |from| self.options.hub.markCopy(opened.tab, from, opened.goneFolder orelse "");

        const payload = json.encode(a, hub.infoOf(opened.tab, self.options.io)) catch
            return self.text(request, .internal_server_error, "encode");
        return self.respond(request, .created, "application/json", payload);
    }

    /// A session can be named by id or by the file that stores it, but the file
    /// has to sit in the session store: Pi is handed the path verbatim.
    fn insideStore(self: *Server, path: []const u8) bool {
        return std.mem.startsWith(u8, path, self.options.index.root) and
            std.mem.indexOf(u8, path, "..") == null;
    }

    fn settings(self: *Server, request: *std.http.Server.Request, a: std.mem.Allocator) !void {
        const io = self.options.io;

        if (request.head.method == .GET) {
            const ui = self.options.config.uiJson(a) catch
                return self.text(request, .internal_server_error, "oom");
            const cwd = query(a, request.head.target, "cwd") orelse return self.sendJson(request, .ok, ui);
            const payload = std.fmt.allocPrint(
                a,
                "{{\"cwd\":\"{s}\",\"base\":\"{s}\",\"ui\":{s}}}",
                .{ json.escape(a, cwd), self.options.config.baseFor(cwd), ui },
            ) catch return self.text(request, .internal_server_error, "oom");
            return self.sendJson(request, .ok, payload);
        }

        const body = self.readBody(request, a) catch return self.text(request, .bad_request, "body");
        var parsed = std.json.parseFromSlice(std.json.Value, a, body, .{}) catch
            return self.text(request, .bad_request, "not json");
        defer parsed.deinit();
        if (parsed.value != .object) return self.text(request, .bad_request, "object required");

        if (protocol.get(parsed.value.object, "ui")) |patch| {
            if (patch != .object) return self.text(request, .bad_request, "ui must be an object");
            self.options.config.patchUi(patch.object) catch |err| switch (err) {
                error.BadValue => return self.text(request, .bad_request, "unknown ui value"),
                else => return self.text(request, .internal_server_error, "write failed"),
            };

            const ui = self.options.config.uiJson(a) catch
                return self.text(request, .internal_server_error, "oom");
            return self.sendJson(request, .ok, ui);
        }

        const cwd = protocol.string(parsed.value.object, "cwd") orelse
            return self.text(request, .bad_request, "cwd required");
        const base_text = protocol.string(parsed.value.object, "base") orelse
            return self.text(request, .bad_request, "base required");

        const base = git.Base.parse(base_text);
        if (base.refName()) |reference| {
            if (!git.validRef(a, io, cwd, reference)) return self.text(request, .bad_request, "unknown ref");
        }

        self.options.config.setBase(cwd, base.text()) catch
            return self.text(request, .internal_server_error, "write failed");
        return self.text(request, .ok, "saved");
    }

    fn events(self: *Server, request: *std.http.Server.Request, tab: *hub.Tab) !void {
        const a = self.options.allocator;
        const io = self.options.io;
        defer log.info("sse closed {s} after {d} ms", .{ tab.id, log.elapsed() });

        const sub = self.options.hub.subscribe(tab) orelse return self.text(request, .internal_server_error, "oom");
        defer self.options.hub.unsubscribe(tab, sub);

        var scratch: std.heap.ArenaAllocator = .init(a);
        defer scratch.deinit();
        const snapshot = json.encode(scratch.allocator(), hub.infoOf(tab, io)) catch return;
        return self.stream(request, sub, snapshot);
    }

    /// The loop behind both event streams: say what is already there, then
    /// whatever arrives, then a ping when nothing does.
    ///
    /// Whoever calls this subscribes first and hands over what was already worth
    /// sending, because from that moment new frames queue up behind the one the
    /// caller is about to write by hand.
    fn stream(
        self: *Server,
        request: *std.http.Server.Request,
        sub: *hub.Subscriber,
        opening: ?[]const u8,
    ) !void {
        const a = self.options.allocator;
        const io = self.options.io;

        var body_buffer: [16 * 1024]u8 = undefined;
        var body = request.respondStreaming(&body_buffer, .{
            .respond_options = .{
                .keep_alive = true,
                .extra_headers = &.{
                    .{ .name = "content-type", .value = "text/event-stream" },
                    .{ .name = "cache-control", .value = "no-cache" },
                },
            },
        }) catch return;

        log.info("sse open", .{});
        body.writer.writeAll("retry: 1500\n\n") catch return;

        if (opening) |first| {
            writeFrame(&body.writer, first) catch return;
            flushStream(&body) catch return;
        }

        var batch: std.ArrayList([]const u8) = .empty;
        defer {
            for (batch.items) |item| a.free(item);
            batch.deinit(a);
        }

        while (true) {
            if (!sub.waitForData(io, heartbeat)) {
                body.writer.writeAll(": ping\n\n") catch return;
                flushStream(&body) catch return;
                continue;
            }

            for (batch.items) |item| a.free(item);
            batch.clearRetainingCapacity();
            sub.take(&batch, io) catch return;

            for (batch.items) |item| {
                writeFrame(&body.writer, item) catch return;
                a.free(item);
            }
            batch.clearRetainingCapacity();
            flushStream(&body) catch return;
        }
    }

    fn openShell(self: *Server, request: *std.http.Server.Request, a: std.mem.Allocator) !void {
        var cwd: []const u8 = "";
        var tab: []const u8 = "";
        var rows: u16 = 24;
        var cols: u16 = 80;

        if (self.readBody(request, a)) |body| {
            if (body.len > 0) {
                var parsed = std.json.parseFromSlice(std.json.Value, a, body, .{}) catch
                    return self.text(request, .bad_request, "not json");
                defer parsed.deinit();
                if (parsed.value == .object) {
                    // The strings live in the parse, and the parse is over with
                    // this block, so anything wanted later is copied out first.
                    cwd = a.dupe(u8, protocol.string(parsed.value.object, "cwd") orelse "") catch
                        return self.text(request, .internal_server_error, "out of memory");
                    tab = a.dupe(u8, protocol.string(parsed.value.object, "tab") orelse "") catch
                        return self.text(request, .internal_server_error, "out of memory");
                    rows = number(parsed.value.object, "rows", 24);
                    cols = number(parsed.value.object, "cols", 80);
                }
            }
        } else |_| {}

        if (cwd.len == 0) return self.text(request, .bad_request, "folder missing");
        Io.Dir.access(.cwd(), self.options.io, cwd, .{}) catch
            return self.text(request, .not_found, "no such folder");

        const shell = self.options.shells.open(cwd, tab, rows, cols) catch |err| switch (err) {
            error.NoWorkdir => return self.text(request, .bad_request, "folder missing"),
            else => return self.text(request, .internal_server_error, "cannot start a shell"),
        };

        const payload = json.encode(a, ShellOne{ .shell = shells.Pool.infoOf(shell, self.options.io) }) catch
            return self.text(request, .internal_server_error, "encode");
        return self.respond(request, .ok, "application/json", payload);
    }

    fn shellFor(self: *Server, request: *std.http.Server.Request, a: std.mem.Allocator) ?*shells.Shell {
        const id = query(a, request.head.target, "id") orelse return null;
        return self.options.shells.get(id);
    }

    /// What is typed in a terminal window, sent on as it came. No JSON in here:
    /// a keystroke is a byte and the body is already bytes.
    fn shellWrite(
        self: *Server,
        request: *std.http.Server.Request,
        shell: *shells.Shell,
        a: std.mem.Allocator,
    ) !void {
        const body = self.readBody(request, a) catch return self.text(request, .bad_request, "body");
        self.options.shells.write(shell, body);
        return self.sendJson(request, .ok, "{\"ok\":true}");
    }

    fn shellResize(
        self: *Server,
        request: *std.http.Server.Request,
        shell: *shells.Shell,
        a: std.mem.Allocator,
    ) !void {
        const target = request.head.target;
        const rows = std.fmt.parseInt(u16, query(a, target, "rows") orelse "", 10) catch 0;
        const cols = std.fmt.parseInt(u16, query(a, target, "cols") orelse "", 10) catch 0;
        if (rows == 0 or cols == 0) return self.text(request, .bad_request, "rows and cols");

        self.options.shells.resize(shell, rows, cols);
        return self.sendJson(request, .ok, "{\"ok\":true}");
    }

    fn shellEvents(self: *Server, request: *std.http.Server.Request, shell: *shells.Shell) !void {
        const a = self.options.allocator;
        defer log.info("shell stream closed after {d} ms", .{log.elapsed()});

        const sub = self.options.shells.subscribe(shell) orelse
            return self.text(request, .internal_server_error, "oom");
        defer self.options.shells.unsubscribe(shell, sub);

        // What the shell wrote before this reader showed up. Reading it out is
        // honest from here on: the queue behind it holds only what came after.
        var scratch: std.heap.ArenaAllocator = .init(a);
        defer scratch.deinit();

        const opening: ?[]const u8 = blk: {
            const kept = shells.backlogOf(shell, scratch.allocator()) orelse break :blk null;
            const encoded = base64Of(scratch.allocator(), kept) orelse break :blk null;
            break :blk json.encode(scratch.allocator(), shells.Output{ .id = shell.id, .data = encoded }) catch
                null;
        };

        return self.stream(request, sub, opening);
    }

    fn tabFor(self: *Server, request: *std.http.Server.Request, a: std.mem.Allocator) ?*hub.Tab {
        const id = query(a, request.head.target, "id") orelse return null;
        return self.options.hub.get(id);
    }

    fn baseFor(self: *Server, request: *std.http.Server.Request, tab: *hub.Tab, a: std.mem.Allocator) git.Base {
        if (query(a, request.head.target, "base")) |value| {
            if (value.len > 0) return git.Base.parse(value);
        }
        return git.Base.parse(self.options.config.baseFor(tab.cwd));
    }

    fn staticFile(self: *Server, request: *std.http.Server.Request, path: []const u8, a: std.mem.Allocator) !void {
        if (self.options.web_root) |root| {
            if (std.mem.indexOf(u8, path, "..") != null) return self.text(request, .not_found, "nope");
            const relative = if (std.mem.eql(u8, path, "/")) "index.html" else path[1..];

            const full = std.fs.path.join(a, &.{ root, relative }) catch
                return self.text(request, .internal_server_error, "oom");
            const content = readFile(a, self.options.io, full) catch return self.text(request, .not_found, "missing");
            return self.sendAsset(request, a, mime(relative), content);
        }

        const asset = assets.lookup(path) orelse return self.text(request, .not_found, "missing");
        return self.sendAsset(request, a, asset.mime, asset.body);
    }

    /// Pages and scripts are baked into the binary, so a rebuild changes them, and
    /// a tab that has been open since the previous server keeps running the
    /// script it arrived with. The browser is told to ask every time, and gets a
    /// bare 304 when the bytes are the ones it already has.
    fn sendAsset(
        self: *Server,
        request: *std.http.Server.Request,
        a: std.mem.Allocator,
        kind: []const u8,
        body: []const u8,
    ) !void {
        const tag = std.fmt.allocPrint(a, "\"{x:0>16}\"", .{fingerprint(body)}) catch
            return self.text(request, .internal_server_error, "oom");
        const headers = [_]std.http.Header{
            .{ .name = "etag", .value = tag },
            .{ .name = "cache-control", .value = "no-cache" },
        };

        if (headerValue(request.head_buffer, "if-none-match")) |sent| {
            if (std.mem.eql(u8, sent, tag)) return self.respondWith(request, .not_modified, kind, "", &headers);
        }
        return self.respondWith(request, .ok, kind, body, &headers);
    }

    fn readBody(_: *Server, request: *std.http.Server.Request, a: std.mem.Allocator) ![]u8 {
        var transfer: [8 * 1024]u8 = undefined;
        const source = request.readerExpectNone(&transfer);

        var out: std.ArrayList(u8) = .empty;
        var chunk: [8 * 1024]u8 = undefined;
        while (out.items.len < max_body) {
            const read = source.readSliceShort(&chunk) catch break;
            if (read == 0) break;
            try out.appendSlice(a, chunk[0..read]);
        }
        return out.items;
    }

    fn text(self: *Server, request: *std.http.Server.Request, status: std.http.Status, message: []const u8) !void {
        return self.respond(request, status, "text/plain; charset=utf-8", message);
    }

    fn sendJson(self: *Server, request: *std.http.Server.Request, status: std.http.Status, body: []const u8) !void {
        return self.respond(request, status, "application/json", body);
    }

    fn respond(self: *Server, request: *std.http.Server.Request, status: std.http.Status, kind: []const u8, body: []const u8) !void {
        return self.respondWith(request, status, kind, body, &.{});
    }

    fn respondWith(
        _: *Server,
        request: *std.http.Server.Request,
        status: std.http.Status,
        kind: []const u8,
        body: []const u8,
        extra: []const std.http.Header,
    ) !void {
        var headers: [8]std.http.Header = undefined;
        headers[0] = .{ .name = "content-type", .value = kind };
        @memcpy(headers[1 .. extra.len + 1], extra);

        request.respond(body, .{
            .status = status,
            .keep_alive = request.head.keep_alive,
            .extra_headers = headers[0 .. extra.len + 1],
        }) catch {
            log.warn("{s} {s} -> {d} write failed", .{ log.method(), log.target(), @backingInt(status) });
            return error.WriteFailed;
        };

        note(status, body);
    }
};

/// The access log. Every API call gets a line, failures get the reason the
/// browser saw, and a broken static file still shows up. `/api/health` is the
/// one exception: it fires on every page load and can only ever say 200.
fn note(status: std.http.Status, body: []const u8) void {
    const target = log.target();
    const code = @backingInt(status);
    const api = std.mem.startsWith(u8, target, "/api/");
    if (!api and code < 400) return;
    if (std.mem.startsWith(u8, target, "/api/health")) return;

    const reason = if (code >= 400) firstLine(body) else "";
    if (code >= 400) {
        log.warn("{s} {s} -> {d} {d} ms {s}", .{ log.method(), target, code, log.elapsed(), reason });
    } else {
        log.info("{s} {s} -> {d} {d} ms", .{ log.method(), target, code, log.elapsed() });
    }
}

/// A log line has to stay one line.
fn firstLine(text: []const u8) []const u8 {
    const cut = std.mem.indexOfScalar(u8, text, '\n') orelse text.len;
    return text[0..cut];
}

const Collector = struct {
    allocator: std.mem.Allocator,
    list: std.ArrayList(hub.TabInfo),
    io: Io,
};

fn collect(collector: *Collector, item: *hub.Tab) void {
    collector.list.append(collector.allocator, hub.infoOf(item, collector.io)) catch {};
}

/// A server-sent frame has to leave now, not when the buffer fills: the chunk
/// encoder keeps a partial chunk until it is full, and the connection buffers on
/// top of that. Both have to be emptied for the browser to see one event.
fn flushStream(body: *std.http.BodyWriter) !void {
    try Io.Writer.defaultFlush(&body.writer);
    try body.flush();
}

fn writeFrame(writer: *Io.Writer, payload: []const u8) !void {
    try writer.writeAll("data: ");
    for (payload) |byte| {
        if (byte == '\r') continue;
        if (byte == '\n') try writer.writeAll("\ndata: ");
        try writer.writeByte(byte);
    }
    try writer.writeAll("\n\n");
}

fn mime(name: []const u8) []const u8 {
    if (std.mem.endsWith(u8, name, ".html")) return "text/html; charset=utf-8";
    if (std.mem.endsWith(u8, name, ".css")) return "text/css; charset=utf-8";
    if (std.mem.endsWith(u8, name, ".js")) return "text/javascript; charset=utf-8";
    if (std.mem.endsWith(u8, name, ".json")) return "application/json";
    return "application/octet-stream";
}

fn readFile(allocator: std.mem.Allocator, io: Io, path: []const u8) ![]u8 {
    var buffer: [8 * 1024]u8 = undefined;
    var file = Io.Dir.cwd().openFile(io, path, .{}) catch return error.NotFound;
    defer file.close(io);

    var stream = file.readerStreaming(io, &buffer);
    var out: std.ArrayList(u8) = .empty;

    var chunk: [8 * 1024]u8 = undefined;
    while (true) {
        const read = stream.interface.readSliceShort(&chunk) catch break;
        if (read == 0) break;
        try out.appendSlice(allocator, chunk[0..read]);
    }
    return out.items;
}

/// One shell, as the browser asked for it.
const ShellOne = struct { ok: bool = true, shell: shells.ShellInfo };

/// The shells standing right now.
const ShellList = struct { ok: bool = true, shells: []const shells.ShellInfo };

/// A size from a browser payload, where anything that is not a plausible number
/// means the caller did not say and the default stands.
fn number(object: std.json.ObjectMap, key: []const u8, fallback: u16) u16 {
    const value = object.get(key) orelse return fallback;
    return switch (value) {
        .integer => |n| if (n > 0 and n <= 4096) @intCast(n) else fallback,
        else => fallback,
    };
}

/// Terminal bytes in the only shape an event stream carries without one of them
/// being read as part of the framing.
fn base64Of(a: std.mem.Allocator, bytes: []const u8) ?[]const u8 {
    const out = a.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len)) catch return null;
    return std.base64.standard.Encoder.encode(out, bytes);
}

fn query(a: std.mem.Allocator, target: []const u8, name: []const u8) ?[]const u8 {
    const question = std.mem.indexOfScalar(u8, target, '?') orelse return null;
    var pairs = std.mem.splitScalar(u8, target[question + 1 ..], '&');
    while (pairs.next()) |pair| {
        const equals = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        if (!std.mem.eql(u8, pair[0..equals], name)) continue;
        return unescape(a, pair[equals + 1 ..]);
    }
    return null;
}

/// A browser sends a path as mostly `%2F`, which is useless until it comes back
/// off. Values without an escape keep pointing at the request line.
fn unescape(a: std.mem.Allocator, value: []const u8) []const u8 {
    if (std.mem.indexOfScalar(u8, value, '%') == null) return value;
    const buffer = a.alloc(u8, value.len) catch return value;
    return std.Uri.percentDecodeBackwards(buffer, value);
}

/// A request head is kept as raw bytes, so a header is read out of them here.
fn headerValue(head: []const u8, name: []const u8) ?[]const u8 {
    var lines = std.mem.splitScalar(u8, head, '\n');
    while (lines.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        if (!std.ascii.eqlIgnoreCase(line[0..colon], name)) continue;
        const value = std.mem.trim(u8, line[colon + 1 ..], " \t\r");
        if (value.len == 0) return null;
        return value;
    }
    return null;
}

fn fingerprint(text: []const u8) u64 {
    var hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (text) |byte| {
        hash ^= byte;
        hash *%= 0x0000_0100_0000_01b3;
    }
    return hash;
}

test "an asset fingerprint moves when a byte moves" {
    try std.testing.expectEqual(fingerprint("web/app.js"), fingerprint("web/app.js"));
    try std.testing.expect(fingerprint("web/app.js") != fingerprint("web/app-js"));
}
