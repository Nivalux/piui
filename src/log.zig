//! One line per event on stderr. Unbuffered, so a crash still leaves the line
//! it reached.
//!
//! The clock is UTC with a `Z` on the end. The box may run any zone and the
//! log may not quietly claim to run in the reader's.

const std = @import("std");
const Io = std.Io;

/// Longest request line kept for the log; anything past it is a very long query
/// string and rarely the interesting part.
pub const target_limit = 200;

var io: Io = undefined;
var on = false;
threadlocal var request_at: i64 = 0;
threadlocal var request_method: []const u8 = "";
threadlocal var request_target: [target_limit]u8 = undefined;
threadlocal var request_len: usize = 0;

/// Turns logging on. Until this runs the calls are silent, so a failure before
/// the clock exists cannot take the process down while reporting it.
pub fn init(at: Io) void {
    io = at;
    on = true;
}

pub fn info(comptime format: []const u8, args: anytype) void {
    emit("info", format, args);
}

pub fn warn(comptime format: []const u8, args: anytype) void {
    emit("warn", format, args);
}

/// Remembers what this thread is answering. The request line is only readable
/// until the response goes out - by the time a handler knows the status code,
/// the bytes it pointed at belong to the connection again.
pub fn begin(verb: []const u8, line: []const u8) void {
    if (!on) return;
    request_at = monotonic();
    request_method = verb;
    request_len = @min(line.len, request_target.len);
    @memcpy(request_target[0..request_len], line[0..request_len]);
}

pub fn method() []const u8 {
    return request_method;
}

pub fn target() []const u8 {
    if (request_at == 0) return "";
    return request_target[0..request_len];
}

/// Milliseconds since `begin`, or 0 outside a request.
pub fn elapsed() i64 {
    if (!on or request_at == 0) return 0;
    return monotonic() - request_at;
}

fn monotonic() i64 {
    return Io.Timestamp.now(io, .awake).toMilliseconds();
}

fn emit(level: []const u8, comptime format: []const u8, args: anytype) void {
    if (!on) return;

    var body: [1024]u8 = undefined;
    const text = std.fmt.bufPrint(&body, format, args) catch return;

    const hour_ms: i64 = 60 * 60 * 1000;
    const minute_ms: i64 = 60 * 1000;
    var rest = @mod(Io.Timestamp.now(io, .real).toMilliseconds(), @as(i64, 24 * hour_ms));
    const hour = @divTrunc(rest, hour_ms);
    rest -= hour * hour_ms;
    const minute = @divTrunc(rest, minute_ms);
    rest -= minute * minute_ms;
    const second = @divTrunc(rest, 1000);
    const milli = rest - second * 1000;

    var line: [1400]u8 = undefined;
    const full = std.fmt.bufPrint(&line, "{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z {s} {s}\n", .{
        @as(u32, @intCast(hour)),
        @as(u32, @intCast(minute)),
        @as(u32, @intCast(second)),
        @as(u32, @intCast(milli)),
        level,
        text,
    }) catch return;

    Io.File.stderr().writeStreamingAll(io, full) catch {};
}
