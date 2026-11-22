const std = @import("std");
const Io = std.Io;

pub fn encode(allocator: std.mem.Allocator, value: anytype) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, value, .{});
}

pub fn nowMs(io: Io) i64 {
    return Io.Timestamp.now(io, .awake).toMilliseconds();
}

/// Wall-clock milliseconds since the Unix epoch — the only clock a browser can read. `nowMs` counts
/// from an unspecified point and is good inside this process alone.
pub fn epochMs(io: Io) i64 {
    return Io.Timestamp.now(io, .real).toMilliseconds();
}

pub fn escape(allocator: std.mem.Allocator, text: []const u8) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (text) |byte| {
        switch (byte) {
            '"' => out.appendSlice(allocator, "\\\"") catch return "",
            '\\' => out.appendSlice(allocator, "\\\\") catch return "",
            '\n' => out.appendSlice(allocator, "\\n") catch return "",
            '\r' => out.appendSlice(allocator, "\\r") catch return "",
            '\t' => out.appendSlice(allocator, "\\t") catch return "",
            else => {
                if (byte < 0x20) continue;
                out.append(allocator, byte) catch return "";
            },
        }
    }
    return out.items;
}

/// Strips CR so a payload cannot forge an extra SSE frame.
pub fn oneLine(allocator: std.mem.Allocator, text: []const u8) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (text) |byte| {
        if (byte == '\r') continue;
        out.append(allocator, byte) catch return "";
    }
    return out.items;
}
