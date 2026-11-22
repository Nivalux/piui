const std = @import("std");
const Io = std.Io;
const testing = std.testing;
const piui = @import("piui");
const files = piui.files;

test "a listing walks the tree and leaves the machine-made folders out" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var root = std.testing.tmpDir(.{});
    defer root.cleanup();

    try root.dir.createDirPath(io, "src/deep");
    try root.dir.createDirPath(io, "node_modules/pkg");
    try root.dir.createDirPath(io, "zig-out/bin");
    try root.dir.createDirPath(io, ".git/objects");
    try root.dir.writeFile(io, .{ .sub_path = "readme.md", .data = "# hi\n" });
    try root.dir.writeFile(io, .{ .sub_path = "src/main.zig", .data = "fn main() {}\n" });
    try root.dir.writeFile(io, .{ .sub_path = "src/deep/note.md", .data = "note\n" });
    try root.dir.writeFile(io, .{ .sub_path = "node_modules/pkg/index.js", .data = "x" });
    try root.dir.writeFile(io, .{ .sub_path = ".git/config", .data = "x" });

    var buffer: [4096]u8 = undefined;
    const length = root.dir.realPath(io, &buffer) catch return error.SkipZigTest;
    const base = buffer[0..length];

    const listing = try files.list(a, io, base, 100);
    try expectPaths(&.{ "readme.md", "src/deep/note.md", "src/main.zig" }, listing.files);
    try testing.expect(!listing.truncated);

    const capped = try files.list(a, io, base, 2);
    try testing.expectEqual(@as(usize, 2), capped.files.len);
    try testing.expect(capped.truncated);
}

test "a read returns the file and says when it stopped short" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var root = std.testing.tmpDir(.{});
    defer root.cleanup();

    try root.dir.createDirPath(io, "src");
    try root.dir.writeFile(io, .{ .sub_path = "src/main.zig", .data = "fn main() {}\n" });
    try root.dir.writeFile(io, .{ .sub_path = "blob.bin", .data = "ab\x00cd" });
    var big: [files.max_read_bytes + 4]u8 = undefined;
    @memset(&big, 'x');
    big[big.len - 1] = '\n';
    try root.dir.writeFile(io, .{ .sub_path = "big.txt", .data = &big });

    var cut: [files.max_read_bytes + 2]u8 = undefined;
    @memset(&cut, 'y');
    cut[cut.len - 2] = 0xC3;
    cut[cut.len - 1] = 0xA9;
    try root.dir.writeFile(io, .{ .sub_path = "cut.txt", .data = &cut });

    var buffer: [4096]u8 = undefined;
    const length = root.dir.realPath(io, &buffer) catch return error.SkipZigTest;
    const base = buffer[0..length];

    const read = try files.read(a, io, base, "src/main.zig");
    try testing.expectEqualStrings("fn main() {}\n", read.text);
    try testing.expect(!read.truncated);
    try testing.expect(!read.binary);
    try testing.expect(std.mem.endsWith(u8, read.path, "/src/main.zig"));

    try testing.expectError(error.Outside, files.read(a, io, base, base));

    const binary = try files.read(a, io, base, "blob.bin");
    try testing.expect(binary.binary);
    try testing.expectEqual(@as(usize, 0), binary.text.len);

    const long = try files.read(a, io, base, "big.txt");
    try testing.expect(long.truncated);
    try testing.expectEqual(files.max_read_bytes, long.text.len);

    const cut_read = try files.read(a, io, base, "cut.txt");
    try testing.expect(cut_read.truncated);
    try testing.expect(!cut_read.binary);
    try testing.expect(std.unicode.utf8ValidateSlice(cut_read.text));
}

test "a path that leaves the project is refused" {
    var threaded: Io.Threaded = .init(testing.allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var root = std.testing.tmpDir(.{});
    defer root.cleanup();
    try root.dir.createDirPath(io, "src");
    try root.dir.writeFile(io, .{ .sub_path = "src/main.zig", .data = "x" });

    var buffer: [4096]u8 = undefined;
    const length = root.dir.realPath(io, &buffer) catch return error.SkipZigTest;
    const base = buffer[0..length];

    try testing.expectError(error.Outside, files.read(a, io, base, "../outside.txt"));
    try testing.expectError(error.Outside, files.read(a, io, base, "src/../../outside.txt"));
    try testing.expectError(error.Outside, files.read(a, io, base, "/etc/passwd"));
    try testing.expectError(error.NotFound, files.read(a, io, base, ""));
    try testing.expectError(error.Outside, files.read(a, io, base, "../x-escape"));

    try testing.expectError(error.NotFound, files.read(a, io, base, "src/gone.zig"));
    try testing.expectError(error.NotFile, files.read(a, io, base, "src"));
}

fn expectPaths(expected: []const []const u8, found: []const files.Entry) !void {
    try testing.expectEqual(expected.len, found.len);
    for (expected, found) |want, got| try testing.expectEqualStrings(want, got.path);
}
