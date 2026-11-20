//! The token gate.
//!
//! piui can start a `pi` with the user's whole filesystem and credentials, so a
//! free-for-all port is not acceptable even on a laptop: any other process, or
//! any page the browser has open, could otherwise prompt its way to a shell. On
//! first start piui mints a token, keeps it in `<config dir>/token` with mode
//! 0600, and the browser has to show it once.
//!
//! The browser then carries it in an `HttpOnly` cookie. That is what keeps a
//! reload signed in without the page ever being able to read the secret, and it
//! works for the SSE stream, which cannot send a header of its own.

const std = @import("std");
const Io = std.Io;

pub const cookie_name = "piui";
pub const max_age_seconds = 30 * 24 * 60 * 60;

/// 20 bytes is 40 hex characters: long enough that guessing is not a strategy,
/// short enough to paste.
pub const secret_len = 20;

pub const Error = error{ OutOfMemory, StorageFailed };

pub const Token = struct {
    secret: [secret_len]u8,

    /// The stored token, created and written when there is none yet.
    pub fn loadOrCreate(allocator: std.mem.Allocator, io: Io, path: []const u8) !Token {
        if (load(io, path)) |existing| return existing;

        var token = Token{ .secret = undefined };
        io.randomSecure(&token.secret) catch return error.StorageFailed;
        write(allocator, io, path, token) catch return error.StorageFailed;
        return token;
    }

    fn load(io: Io, path: []const u8) ?Token {
        var buffer: [128]u8 = undefined;
        var file = Io.Dir.cwd().openFile(io, path, .{}) catch return null;
        defer file.close(io);

        var stream = file.readerStreaming(io, &buffer);
        var chunk: [64]u8 = undefined;
        const read = stream.interface.readSliceShort(&chunk) catch return null;
        return fromHex(std.mem.trim(u8, chunk[0..read], " \t\r\n"));
    }

    fn write(allocator: std.mem.Allocator, io: Io, path: []const u8, token: Token) !void {
        const text = std.fmt.allocPrint(allocator, "{s}\n", .{token.hex()}) catch return error.OutOfMemory;
        defer allocator.free(text);

        var atomic = Io.Dir.cwd().createFileAtomic(io, path, .{
            .replace = true,
            .permissions = .fromMode(0o600),
        }) catch return error.StorageFailed;
        defer atomic.deinit(io);

        atomic.file.writeStreamingAll(io, text) catch return error.StorageFailed;
        atomic.replace(io) catch return error.StorageFailed;
    }

    pub fn fromHex(text: []const u8) ?Token {
        if (text.len != secret_len * 2) return null;
        var secret: [secret_len]u8 = undefined;
        for (&secret, 0..) |*byte, index| {
            const high = std.fmt.charToDigit(text[index * 2], 16) catch return null;
            const low = std.fmt.charToDigit(text[index * 2 + 1], 16) catch return null;
            byte.* = high * 16 + low;
        }
        return .{ .secret = secret };
    }

    pub fn hex(self: Token) [secret_len * 2]u8 {
        return std.fmt.bytesToHex(&self.secret, .lower);
    }

    /// Constant time in the length of a token, so a wrong guess tells nothing
    /// about which characters were right.
    pub fn matches(self: Token, candidate: []const u8) bool {
        const given = fromHex(candidate) orelse return false;
        return std.crypto.timing_safe.eql([secret_len]u8, self.secret, given.secret);
    }

    pub fn setCookie(self: Token, allocator: std.mem.Allocator) ![]u8 {
        return std.fmt.allocPrint(
            allocator,
            "{s}={s}; Path=/; HttpOnly; SameSite=Strict; Max-Age={d}",
            .{ cookie_name, self.hex(), max_age_seconds },
        ) catch error.OutOfMemory;
    }
};

pub fn clearCookie(allocator: std.mem.Allocator) ![]u8 {
    return std.fmt.allocPrint(
        allocator,
        "{s}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        .{cookie_name},
    ) catch error.OutOfMemory;
}

/// The value of one cookie from a raw request head.
///
/// `std.http.Server` keeps only the handful of headers it understands, so the
/// cookie has to be fished out of the bytes the parser was given. `head_buffer`
/// stays valid for the whole request, which is what makes this cheap.
pub fn cookieValue(head: []const u8, name: []const u8) ?[]const u8 {
    var lines = std.mem.splitScalar(u8, head, '\n');
    while (lines.next()) |line| {
        const field = std.mem.trim(u8, line, "\r");
        if (!startsWithIgnoreCase(field, "cookie:")) continue;

        var pairs = std.mem.splitScalar(u8, field["cookie:".len..], ';');
        while (pairs.next()) |pair| {
            const item = std.mem.trim(u8, pair, " ");
            const equals = std.mem.indexOfScalar(u8, item, '=') orelse continue;
            if (!std.mem.eql(u8, item[0..equals], name)) continue;
            return item[equals + 1 ..];
        }
    }
    return null;
}

fn startsWithIgnoreCase(haystack: []const u8, prefix: []const u8) bool {
    if (haystack.len < prefix.len) return false;
    for (prefix, 0..) |want, index| {
        if (std.ascii.toLower(haystack[index]) != std.ascii.toLower(want)) return false;
    }
    return true;
}

test "a token round-trips through hex" {
    var token = Token{ .secret = undefined };
    for (&token.secret, 0..) |*byte, index| byte.* = @intCast(index + 1);

    const text = token.hex();
    try std.testing.expectEqualStrings("0102030405060708090a0b0c0d0e0f1011121314", &text);
    try std.testing.expect(token.matches(&text));
}

test "a wrong or malformed token is refused" {
    var token = Token{ .secret = undefined };
    for (&token.secret) |*byte| byte.* = 0x5a;

    try std.testing.expect(!token.matches("nope"));
    try std.testing.expect(!token.matches(""));
    try std.testing.expect(!token.matches("0102030405060708090a0b0c0d0e0f1011121315"));
    try std.testing.expect(!token.matches("zz02030405060708090a0b0c0d0e0f1011121314"));
}

test "the cookie is read out of a request head" {
    const head =
        \\GET /api/tabs HTTP/1.1
        \\Host: 127.0.0.1:7788
        \\Cookie: theme=light; piui=0102030405060708090a0b0c0d0e0f1011121314; other=1
        \\Accept: */*
        \\
    ;
    try std.testing.expectEqualStrings(
        "0102030405060708090a0b0c0d0e0f1011121314",
        cookieValue(head, cookie_name).?,
    );
    try std.testing.expectEqualStrings("light", cookieValue(head, "theme").?);
    try std.testing.expect(cookieValue(head, "missing") == null);
    try std.testing.expect(cookieValue("GET / HTTP/1.1\n\n", cookie_name) == null);
}
