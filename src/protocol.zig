const std = @import("std");
const Io = std.Io;

pub const Kind = enum {
    response,
    agent_start,
    agent_end,
    agent_settled,
    session_info_changed,
    thinking_level_changed,
    extension_ui_request,
    other,
};

pub const Response = struct {
    command: []const u8 = "",
    success: bool = false,
    session_file: ?[]const u8 = null,
    session_id: ?[]const u8 = null,
    session_name: ?[]const u8 = null,
};

/// What pi sent, reduced to the handful of fields the server routes on.
///
/// Everything else stays untouched on its way to the browser: the transcript is
/// assembled there, so the server has no reason to model all thirty event shapes.
///
/// The fields are copies: `std.json` allocates the strings it parses, so they
/// cannot be borrowed out of a `parseFromSlice` that is already deinited. Whoever
/// calls `parse` owns the copies until it calls `deinit`.
pub const Record = struct {
    kind: Kind,
    id: ?[]const u8 = null,
    response: Response = .{},
    name: ?[]const u8 = null,

    pub fn deinit(self: *Record, allocator: std.mem.Allocator) void {
        if (self.id) |value| allocator.free(value);
        if (self.name) |value| allocator.free(value);
        allocator.free(self.response.command);
        if (self.response.session_file) |value| allocator.free(value);
        if (self.response.session_id) |value| allocator.free(value);
        if (self.response.session_name) |value| allocator.free(value);
        self.* = .{ .kind = .other };
    }
};

pub const ParseError = error{ InvalidRecord, OutOfMemory };

fn copy(allocator: std.mem.Allocator, value: ?[]const u8) ParseError!?[]const u8 {
    const text = value orelse return null;
    return allocator.dupe(u8, text) catch error.OutOfMemory;
}

pub fn parse(allocator: std.mem.Allocator, raw: []const u8) ParseError!Record {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch
        return error.InvalidRecord;
    defer parsed.deinit();

    const object = switch (parsed.value) {
        .object => |o| o,
        else => return error.InvalidRecord,
    };

    const type_name = string(object, "type") orelse return error.InvalidRecord;

    if (std.mem.eql(u8, type_name, "response")) {
        var record = Record{
            .kind = .response,
            .id = try copy(allocator, string(object, "id")),
            .response = .{
                .command = try allocator.dupe(u8, string(object, "command") orelse ""),
                .success = if (get(object, "success")) |s| switch (s) {
                    .bool => |b| b,
                    else => false,
                } else false,
            },
        };

        if (get(object, "data")) |data_value| {
            if (data_value == .object) {
                const data = data_value.object;
                record.response.session_file = try copy(allocator, string(data, "sessionFile"));
                record.response.session_id = try copy(allocator, string(data, "sessionId"));
                record.response.session_name = try copy(allocator, string(data, "sessionName"));
            }
        }
        return record;
    }

    if (std.mem.eql(u8, type_name, "agent_start")) return .{ .kind = .agent_start };
    if (std.mem.eql(u8, type_name, "agent_end")) return .{ .kind = .agent_end };
    if (std.mem.eql(u8, type_name, "agent_settled")) return .{ .kind = .agent_settled };
    if (std.mem.eql(u8, type_name, "session_info_changed")) {
        return .{ .kind = .session_info_changed, .name = try copy(allocator, string(object, "name")) };
    }
    if (std.mem.eql(u8, type_name, "thinking_level_changed")) return .{ .kind = .thinking_level_changed };
    if (std.mem.eql(u8, type_name, "extension_ui_request")) {
        return .{ .kind = .extension_ui_request, .id = try copy(allocator, string(object, "id")) };
    }
    return .{ .kind = .other };
}

pub fn get(object: std.json.ObjectMap, key: []const u8) ?std.json.Value {
    return object.get(key);
}

pub fn string(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .string => |s| s,
        else => null,
    };
}

pub fn integer(object: std.json.ObjectMap, key: []const u8) ?i64 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .integer => |n| n,
        else => null,
    };
}

/// Adds a request id when the browser did not supply one, so the response can
/// be matched to the command that caused it.
pub fn ensureId(allocator: std.mem.Allocator, raw: []const u8, id: []const u8) ![]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, raw, .{}) catch
        return error.InvalidRecord;
    defer parsed.deinit();

    if (parsed.value != .object) return error.InvalidRecord;
    if (parsed.value.object.get("id") != null) return allocator.dupe(u8, raw);

    var out: Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    try parsed.value.object.put(allocator, "id", .{ .string = id });
    try std.json.Stringify.value(parsed.value, .{}, &out.writer);
    return out.toOwnedSlice();
}
