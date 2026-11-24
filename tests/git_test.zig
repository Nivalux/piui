const std = @import("std");
const Io = std.Io;
const testing = std.testing;
const piui = @import("piui");
const git = piui.git;

test "status and diff of a working tree" {
    var threaded: Io.Threaded = .init(testing.allocator, .{ .environ = testing.environ });
    defer threaded.deinit();
    const io = threaded.io();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const repo = try buildRepo(io, a);

    const status = git.status(a, io, repo, .working);
    try testing.expectEqual(@as(?[]const u8, null), status.errorMessage);
    try testing.expectEqualStrings("master", status.branch);
    try testing.expectEqual(@as(usize, 2), status.files.len);

    const modified = findFile(status.files, "f.txt") orelse return error.TestUnexpectedResult;
    try testing.expectEqualStrings("M", modified.status);
    try testing.expect(!modified.staged);
    try testing.expect(!modified.untracked);

    const added = findFile(status.files, "new.txt") orelse return error.TestUnexpectedResult;
    try testing.expectEqualStrings("?", added.status);
    try testing.expect(added.untracked);

    const patch = try git.diff(a, io, repo, .working, null);
    try testing.expect(std.mem.indexOf(u8, patch, "@@ -1,3 +1,3 @@") != null);
    try testing.expect(std.mem.indexOf(u8, patch, "+B") != null);

    const one = try git.diff(a, io, repo, .working, "new.txt");
    try testing.expect(std.mem.indexOf(u8, one, "new.txt") != null);
}

test "a file that differs only in its line endings is not a change" {
    var threaded: Io.Threaded = .init(testing.allocator, .{ .environ = testing.environ });
    defer threaded.deinit();
    const io = threaded.io();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const repo = try join(a, &.{ try root(a), "eol" });
    try Io.Dir.cwd().deleteTree(io, repo);
    try Io.Dir.cwd().createDirPath(io, repo);

    try run(io, a, repo, &.{ "init", "-q", "-b", "master", "." });
    try write(io, a, repo, "f.txt", "a\r\nb\r\nc\r\n");
    try write(io, a, repo, "g.txt", "x\n");
    try run(io, a, repo, &.{ "-c", "core.autocrlf=false", "add", "." });
    try run(io, a, repo, &.{ "-c", "core.autocrlf=false", "-c", "user.email=piui@test", "-c", "user.name=piui", "commit", "-qm", "start" });

    try write(io, a, repo, "f.txt", "a\nB\nc\n");
    try write(io, a, repo, "g.txt", "x\r\n");

    const status = git.status(a, io, repo, .working);
    try testing.expectEqual(@as(usize, 1), status.files.len);
    try testing.expectEqual(@as(u32, 1), status.insertions);
    try testing.expectEqual(@as(u32, 1), status.deletions);

    const edit = findFile(status.files, "f.txt") orelse return error.TestUnexpectedResult;
    try testing.expectEqual(@as(u32, 1), edit.insertions);
    try testing.expectEqual(@as(u32, 1), edit.deletions);

    const patch = try git.diff(a, io, repo, .working, null);
    try testing.expect(std.mem.indexOf(u8, patch, "+B") != null);
    try testing.expect(std.mem.indexOf(u8, patch, "-a") == null);
}

test "a base of the working tree counts lines, a base of a branch counts commits" {
    var threaded: Io.Threaded = .init(testing.allocator, .{ .environ = testing.environ });
    defer threaded.deinit();
    const io = threaded.io();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const repo = try buildRepo(io, a);

    const seed = try join(a, &.{ try root(a), "seed" });
    try Io.Dir.cwd().deleteTree(io, seed);
    try Io.Dir.cwd().createDirPath(io, seed);
    try run(io, a, seed, &.{ "init", "-q", "--bare", "." });

    try run(io, a, repo, &.{ "remote", "add", "origin", seed });
    try run(io, a, repo, &.{ "push", "-q", "-u", "origin", "master" });

    try write(io, a, repo, "g.txt", "more\n");
    try run(io, a, repo, &.{ "add", "g.txt" });
    try run(io, a, repo, &.{ "-c", "user.email=piui@test", "-c", "user.name=piui", "commit", "-qm", "ahead" });

    const working = git.status(a, io, repo, .working);
    try testing.expectEqual(@as(u32, 0), working.ahead);
    try testing.expectEqual(@as(u32, 0), working.behind);
    try testing.expectEqual(@as(u32, 1), working.insertions);
    try testing.expectEqual(@as(u32, 1), working.deletions);

    const edit = findFile(working.files, "f.txt") orelse return error.TestUnexpectedResult;
    try testing.expectEqual(@as(u32, 1), edit.insertions);
    try testing.expectEqual(@as(u32, 1), edit.deletions);

    const fresh = findFile(working.files, "new.txt") orelse return error.TestUnexpectedResult;
    try testing.expectEqual(@as(u32, 0), fresh.insertions);

    const staged = git.status(a, io, repo, .staged);
    try testing.expectEqual(@as(u32, 0), staged.insertions);
    try testing.expectEqual(@as(u32, 0), staged.deletions);

    const remote = git.status(a, io, repo, .{ .branch = "refs/remotes/origin/master" });
    try testing.expectEqual(@as(u32, 1), remote.ahead);
    try testing.expectEqual(@as(u32, 0), remote.insertions);

    const pushed = findFile(remote.files, "g.txt") orelse return error.TestUnexpectedResult;
    try testing.expectEqual(@as(u32, 1), pushed.insertions);
    try testing.expectEqual(@as(u32, 0), pushed.deletions);
}

test "a directory without a repository says so" {
    var threaded: Io.Threaded = .init(testing.allocator, .{ .environ = testing.environ });
    defer threaded.deinit();
    const io = threaded.io();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const bare = try join(a, &.{ try root(a), "bare" });
    try Io.Dir.cwd().deleteTree(io, bare);
    try Io.Dir.cwd().createDirPath(io, bare);

    if (git.isRepository(a, io, bare)) return error.TestUnexpectedResult;

    const status = git.status(a, io, bare, .working);
    try testing.expectEqualStrings(git.not_a_repository, status.errorMessage.?);
    try testing.expectEqual(@as(usize, 0), status.files.len);

    try testing.expectError(error.NotRepository, git.diff(a, io, bare, .working, null));
    try testing.expectEqual(@as(usize, 0), git.branches(a, io, bare).names.len);
}

test "the branches to compare against are the local ones, then the remotes' copies" {
    var threaded: Io.Threaded = .init(testing.allocator, .{ .environ = testing.environ });
    defer threaded.deinit();
    const io = threaded.io();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const repo = try buildRepo(io, a);
    try run(io, a, repo, &.{ "branch", "release" });
    try run(io, a, repo, &.{ "update-ref", "refs/remotes/origin/main", "HEAD" });
    try run(io, a, repo, &.{ "update-ref", "refs/remotes/origin/HEAD", "HEAD" });

    const want = [_]git.Name{
        .{ .name = "master", .ahead = 0, .behind = 0 },
        .{ .name = "release", .ahead = 0, .behind = 0 },
        .{ .name = "origin/main", .ahead = 0, .behind = 0 },
    };

    const found = git.branches(a, io, repo);
    try testing.expectEqualStrings("master", found.branch);
    try testing.expectEqual(want.len, found.names.len);
    for (want, found.names) |one, got| {
        try testing.expectEqualStrings(one.name, got.name);
        try testing.expectEqual(one.ahead, got.ahead);
        try testing.expectEqual(one.behind, got.behind);
    }
}

test "a branch ahead of this checkout says by how much" {
    var threaded: Io.Threaded = .init(testing.allocator, .{ .environ = testing.environ });
    defer threaded.deinit();
    const io = threaded.io();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const repo = try buildRepo(io, a);
    try run(io, a, repo, &.{ "branch", "release" });
    try run(io, a, repo, &.{ "-c", "user.email=piui@test", "-c", "user.name=piui", "commit", "-qam", "edited" });

    const found = git.branches(a, io, repo);
    try testing.expectEqual(@as(usize, 2), found.names.len);
    try testing.expectEqualStrings("master", found.names[0].name);
    try testing.expectEqual(@as(u32, 0), found.names[0].ahead);
    try testing.expectEqualStrings("release", found.names[1].name);
    try testing.expectEqual(@as(u32, 1), found.names[1].ahead);
    try testing.expectEqual(@as(u32, 0), found.names[1].behind);

    const status = git.status(a, io, repo, .{ .branch = "release" });
    try testing.expectEqual(@as(u32, 1), status.ahead);
    try testing.expectEqual(@as(u32, 0), status.behind);
}

fn findFile(files: []const git.FileStatus, path: []const u8) ?git.FileStatus {
    for (files) |file| {
        if (std.mem.eql(u8, file.path, path)) return file;
    }
    return null;
}

/// A commit, then one edited line and one untracked file.
fn buildRepo(io: Io, a: std.mem.Allocator) ![]const u8 {
    const repo = try join(a, &.{ try root(a), "repo" });
    try Io.Dir.cwd().deleteTree(io, repo);
    try Io.Dir.cwd().createDirPath(io, repo);

    try run(io, a, repo, &.{ "init", "-q", "-b", "master", "." });
    try write(io, a, repo, "f.txt", "a\nb\nc\n");
    try run(io, a, repo, &.{ "add", "f.txt" });
    try run(io, a, repo, &.{ "-c", "user.email=piui@test", "-c", "user.name=piui", "commit", "-qm", "start" });
    try write(io, a, repo, "f.txt", "a\nB\nc\n");
    try write(io, a, repo, "new.txt", "fresh\n");
    return repo;
}

/// Outside the project directory, so that a checkout can never become the repository the tests
/// below are looking at.
fn root(allocator: std.mem.Allocator) ![]const u8 {
    const tmp = std.process.Environ.getPosix(testing.environ, "TMPDIR") orelse "/tmp";
    return join(allocator, &.{ tmp, "piui-git-fixture" });
}

fn write(io: Io, a: std.mem.Allocator, dir: []const u8, name: []const u8, data: []const u8) !void {
    const path = try join(a, &.{ dir, name });
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = data });
}

fn join(a: std.mem.Allocator, parts: []const []const u8) ![]const u8 {
    return std.fs.path.join(a, parts);
}

fn run(io: Io, a: std.mem.Allocator, cwd: []const u8, argv: []const []const u8) !void {
    var full: std.ArrayList([]const u8) = .empty;
    try full.append(a, "git");
    for (argv) |item| try full.append(a, item);

    const result = try std.process.run(a, io, .{
        .argv = full.items,
        .cwd = .{ .path = cwd },
        .stdout_limit = .limited(4096),
        .stderr_limit = .limited(4096),
    });
    errdefer a.free(result.stdout);
    if (!result.term.success()) return error.BadSetup;
}
