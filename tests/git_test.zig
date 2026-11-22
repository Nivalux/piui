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

    const want = [_][]const u8{ "master", "release", "origin/main" };
    const names = git.branches(a, io, repo).names;
    try testing.expectEqual(want.len, names.len);
    for (want, names) |one, got| try testing.expectEqualStrings(one, got);
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
