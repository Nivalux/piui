const std = @import("std");
const generated = @import("web_assets");

pub const Asset = struct {
    name: []const u8,
    mime: []const u8,
    body: []const u8,
};

/// One fingerprint over every baked file.
pub const build: []const u8 = blk: {
    @setEvalBranchQuota(200_000_000);
    var sum: u64 = 0xcbf29ce484222325;
    for (generated.entries) |entry| {
        for (entry.name) |byte| sum = (sum ^ byte) *% 0x100000001b3;
        for (entry.body) |byte| sum = (sum ^ byte) *% 0x100000001b3;
    }
    break :blk std.fmt.comptimePrint("{x:0>16}", .{sum});
};

pub fn lookup(name: []const u8) ?Asset {
    const wanted = if (std.mem.eql(u8, name, "/") or name.len == 0) "/index.html" else name;
    for (generated.entries) |entry| {
        if (std.mem.eql(u8, entry.name, wanted)) return assetOf(entry);
    }
    return null;
}

pub fn mime(name: []const u8) []const u8 {
    if (std.mem.endsWith(u8, name, ".html")) return "text/html; charset=utf-8";
    if (std.mem.endsWith(u8, name, ".css")) return "text/css; charset=utf-8";
    if (std.mem.endsWith(u8, name, ".js")) return "text/javascript; charset=utf-8";
    if (std.mem.endsWith(u8, name, ".json")) return "application/json";
    if (std.mem.endsWith(u8, name, ".ttf")) return "font/ttf";
    if (std.mem.endsWith(u8, name, ".woff2")) return "font/woff2";
    if (std.mem.endsWith(u8, name, ".svg")) return "image/svg+xml";
    if (std.mem.endsWith(u8, name, ".png")) return "image/png";
    if (std.mem.endsWith(u8, name, ".ico")) return "image/x-icon";
    return "application/octet-stream";
}

fn assetOf(entry: generated.Entry) Asset {
    return .{ .name = entry.name, .mime = mime(entry.name), .body = entry.body };
}

test "the page is served every file it names" {
    const page = (lookup("/") orelse return error.TestMissingIndex).body;

    var rest = page;
    var named: usize = 0;
    while (std.mem.indexOf(u8, rest, "=\"")) |at| {
        const after = rest[at + 2 ..];
        const end = std.mem.indexOfAny(u8, after, "\" >") orelse break;
        const value = after[0..end];
        rest = after[end..];

        if (!std.mem.startsWith(u8, value, "/") or std.mem.indexOf(u8, value, ".") == null) continue;
        named += 1;
        try std.testing.expect(lookup(value) != null);
    }

    try std.testing.expect(named > 0);
}

test "a file the page does not name is still served" {
    try std.testing.expect(lookup("/app.js") != null);
    try std.testing.expect(lookup("/style.css") != null);
    try std.testing.expectEqualStrings("text/javascript; charset=utf-8", (lookup("/rate.js") orelse return error.TestMissing).mime);
    try std.testing.expect(lookup("/nope.js") == null);
}

test "the font is baked whole, bytes and all" {
    const font = lookup("/fonts/dejavu-sans-mono.ttf") orelse return error.TestMissingFont;
    try std.testing.expectEqualStrings("font/ttf", font.mime);
    try std.testing.expectEqual(@as(u8, 0), font.body[0]);
    try std.testing.expectEqual(@as(u8, 1), font.body[1]);
    try std.testing.expect(font.body.len > 300_000);
}
