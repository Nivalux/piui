const std = @import("std");

pub const Asset = struct {
    name: []const u8,
    mime: []const u8,
    body: []const u8,
};

pub const files = [_]Asset{
    .{ .name = "/", .mime = "text/html; charset=utf-8", .body = @embedFile("../web/index.html") },
    .{ .name = "/index.html", .mime = "text/html; charset=utf-8", .body = @embedFile("../web/index.html") },
    .{ .name = "/style.css", .mime = "text/css; charset=utf-8", .body = @embedFile("../web/style.css") },
    .{ .name = "/app.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/app.js") },
    .{ .name = "/transcript.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/transcript.js") },
    .{ .name = "/rate.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/rate.js") },
    .{ .name = "/format.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/format.js") },
    .{ .name = "/diff.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/diff.js") },
    .{ .name = "/protocol.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/protocol.js") },
    .{ .name = "/commands.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/commands.js") },
    .{ .name = "/toolview.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/toolview.js") },
    .{ .name = "/markdown.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/markdown.js") },
    .{ .name = "/tabs.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/tabs.js") },
    .{ .name = "/filter.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/filter.js") },
    .{ .name = "/dirview.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/dirview.js") },
    .{ .name = "/panel.js", .mime = "text/javascript; charset=utf-8", .body = @embedFile("../web/panel.js") },
};

pub fn lookup(name: []const u8) ?Asset {
    for (files) |asset| {
        if (std.mem.eql(u8, asset.name, name)) return asset;
    }
    return null;
}
