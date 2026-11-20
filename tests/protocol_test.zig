//! Reducing Pi's stdout records to what the server routes on.

const std = @import("std");
const testing = std.testing;
const piui = @import("piui");
const protocol = piui.protocol;

const stream = @embedFile("../testdata/stream.jsonl");
const commands_fixture = @embedFile("../testdata/commands.json");

/// A record owns its strings, so the test keeps the allocator alive for as long
/// as it holds the record.
const Parse = struct {
    arena: std.heap.ArenaAllocator,

    fn init() Parse {
        return .{ .arena = .init(testing.allocator) };
    }

    fn deinit(self: *Parse) void {
        self.arena.deinit();
    }

    fn line(self: *Parse, raw: []const u8) !protocol.Record {
        return protocol.parse(self.arena.allocator(), raw);
    }
};

test "response carries the command, the outcome and the session file" {
    var parse = Parse.init();
    defer parse.deinit();

    const record = try parse.line(
        \\{"id":"req-1","type":"response","command":"get_state","success":true,"data":{"sessionId":"6f2c","sessionFile":"/home/pi/.pi/sessions/a.jsonl"}}
    );
    try testing.expectEqual(protocol.Kind.response, record.kind);
    try testing.expectEqualStrings("req-1", record.id.?);
    try testing.expectEqualStrings("get_state", record.response.command);
    try testing.expect(record.response.success);
    try testing.expectEqualStrings("/home/pi/.pi/sessions/a.jsonl", record.response.session_file.?);
    try testing.expectEqualStrings("6f2c", record.response.session_id.?);
}

test "a failed response keeps success false" {
    var parse = Parse.init();
    defer parse.deinit();

    const record = try parse.line(
        \\{"id":"req-3","type":"response","command":"set_model","success":false,"error":"Model not found: invalid/model"}
    );
    try testing.expectEqual(protocol.Kind.response, record.kind);
    try testing.expect(!record.response.success);
    try testing.expect(record.response.session_file == null);
}

test "the run boundary events" {
    var parse = Parse.init();
    defer parse.deinit();

    try testing.expectEqual(protocol.Kind.agent_start, (try parse.line("{\"type\":\"agent_start\"}")).kind);
    try testing.expectEqual(protocol.Kind.agent_end, (try parse.line("{\"type\":\"agent_end\",\"messages\":[]}")).kind);
    try testing.expectEqual(protocol.Kind.agent_settled, (try parse.line("{\"type\":\"agent_settled\"}")).kind);
}

test "session_info_changed keeps the name, an absent name means cleared" {
    var parse = Parse.init();
    defer parse.deinit();

    const named = try parse.line("{\"type\":\"session_info_changed\",\"name\":\"Fix the red framing test\"}");
    try testing.expectEqual(protocol.Kind.session_info_changed, named.kind);
    try testing.expectEqualStrings("Fix the red framing test", named.name.?);

    const cleared = try parse.line("{\"type\":\"session_info_changed\"}");
    try testing.expectEqual(protocol.Kind.session_info_changed, cleared.kind);
    try testing.expect(cleared.name == null);
}

test "extension dialogs keep their request id" {
    var parse = Parse.init();
    defer parse.deinit();

    const record = try parse.line("{\"type\":\"extension_ui_request\",\"id\":\"ui-7\",\"method\":\"notify\"}");
    try testing.expectEqual(protocol.Kind.extension_ui_request, record.kind);
    try testing.expectEqualStrings("ui-7", record.id.?);
}

test "everything the server does not route on stays other" {
    var parse = Parse.init();
    defer parse.deinit();

    for ([_][]const u8{
        "{\"type\":\"server_start\",\"pid\":4242}",
        "{\"type\":\"turn_start\"}",
        "{\"type\":\"message_start\",\"message\":{\"role\":\"user\",\"content\":[]}}",
        "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"hi\"}}",
        "{\"type\":\"tool_execution_end\",\"toolCallId\":\"toolu_01A\",\"result\":{\"content\":[]}}",
        "{\"type\":\"some_future_event\"}",
    }) |raw| {
        try testing.expectEqual(protocol.Kind.other, (try parse.line(raw)).kind);
    }
}

test "a record that is not a json object is refused" {
    var parse = Parse.init();
    defer parse.deinit();

    for ([_][]const u8{ "", "not json", "[1,2]", "\"text\"", "42", "{\"no_type\":1}" }) |raw| {
        try testing.expectError(error.InvalidRecord, parse.line(raw));
    }
}

test "every fixture line parses" {
    var parse = Parse.init();
    defer parse.deinit();

    var lines = std.mem.splitScalar(u8, stream, '\n');
    var seen: usize = 0;
    while (lines.next()) |raw| {
        if (raw.len == 0) continue;
        _ = parse.line(raw) catch |err| {
            std.debug.print("line {s}\n", .{raw});
            return err;
        };
        seen += 1;
    }
    try testing.expectEqual(@as(usize, 20), seen);
}

test "a record owns the strings it keeps" {
    var buffer: [4096]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buffer);
    const arena = fba.allocator();

    var record = try protocol.parse(arena, "{\"type\":\"session_info_changed\",\"name\":\"kept\"}");
    try testing.expectEqualStrings("kept", record.name.?);

    record.deinit(arena);
    try testing.expect(record.name == null);
}

test "ensureId adds an id to a command and keeps one that is already there" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const added = try protocol.ensureId(arena, "{\"type\":\"get_state\"}", "piui-1");
    try testing.expectEqualStrings("{\"type\":\"get_state\",\"id\":\"piui-1\"}", added);

    const kept = try protocol.ensureId(arena, "{\"id\":\"browser-9\",\"type\":\"abort\"}", "piui-1");
    try testing.expectEqualStrings("{\"id\":\"browser-9\",\"type\":\"abort\"}", kept);
}

test "ensureId refuses what is not an object" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();

    try testing.expectError(error.InvalidRecord, protocol.ensureId(arena_state.allocator(), "[]", "piui-1"));
}

test "get_commands answers with a command list the client can offer" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var parsed = std.json.parseFromSlice(std.json.Value, arena, commands_fixture, .{}) catch
        return error.TestUnexpectedResult;
    defer parsed.deinit();

    const data = protocol.get(parsed.value.object, "data").?;
    const list = protocol.get(data.object, "commands").?;
    try testing.expectEqual(@as(usize, 8), list.array.items.len);

    const first = list.array.items[0].object;
    try testing.expectEqualStrings("fix-tests", protocol.string(first, "name").?);
    try testing.expectEqualStrings("Fix failing tests", protocol.string(first, "description").?);
    try testing.expectEqualStrings("prompt", protocol.string(first, "source").?);
}
