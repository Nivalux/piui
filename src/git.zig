const std = @import("std");
const Io = std.Io;

pub const max_diff_bytes = 2 << 20;
pub const max_status_files = 500;
pub const max_branches = 300;

pub const Base = union(enum) {
    working,
    staged,
    branch: []const u8,
    commit: []const u8,

    pub fn parse(input: ?[]const u8) Base {
        const value = input orelse return .working;
        if (value.len == 0 or std.mem.eql(u8, value, "working")) return .working;
        if (std.mem.eql(u8, value, "staged")) return .staged;
        if (std.mem.startsWith(u8, value, "branch:")) return .{ .branch = value["branch:".len..] };
        if (std.mem.startsWith(u8, value, "commit:")) return .{ .commit = value["commit:".len..] };
        return .working;
    }

    pub fn text(self: Base) []const u8 {
        return switch (self) {
            .working => "working",
            .staged => "staged",
            .branch => |name| name,
            .commit => |sha| sha,
        };
    }

    pub fn label(self: Base) []const u8 {
        return switch (self) {
            .working => "Working changes",
            .staged => "Staged changes",
            .branch => |name| name,
            .commit => |sha| short(sha),
        };
    }

    pub fn refName(self: Base) ?[]const u8 {
        return switch (self) {
            .working => null,
            .staged => "HEAD",
            .branch => |name| name,
            .commit => |sha| sha,
        };
    }
};

pub const FileStatus = struct {
    path: []const u8,
    display: []const u8,
    status: []const u8,
    staged: bool,
    untracked: bool,
    insertions: u32 = 0,
    deletions: u32 = 0,
};

pub const Status = struct {
    base: []const u8,
    label: []const u8,
    branch: []const u8 = "",
    ahead: u32 = 0,
    behind: u32 = 0,
    insertions: u32 = 0,
    deletions: u32 = 0,
    files: []const FileStatus = &.{},
    truncated: bool = false,
    errorMessage: ?[]const u8 = null,
};

pub const Error = error{ GitFailed, NotRepository, TooLarge, OutOfMemory };

/// Said in one place, because the browser shows it.
pub const not_a_repository = "not a git repository";

/// Git's own letters. A status is handed over as a slice of this string so a `FileStatus` never
/// owns memory it has to free.
const codes = "MADRCTU?!";

fn codeText(code: u8) []const u8 {
    if (std.mem.indexOfScalar(u8, codes, code)) |at| return codes[at .. at + 1];
    return "?";
}

pub fn isRepository(allocator: std.mem.Allocator, io: Io, cwd: []const u8) bool {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    _ = git(arena.allocator(), io, cwd, &.{ "rev-parse", "--is-inside-work-tree" }, .limited(1024)) catch return false;
    return true;
}

pub fn validRef(allocator: std.mem.Allocator, io: Io, cwd: []const u8, name: []const u8) bool {
    if (name.len == 0) return false;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    _ = git(arena.allocator(), io, cwd, &.{ "rev-parse", "--verify", "--quiet", name }, .limited(1024)) catch return false;
    return true;
}

pub const Name = struct {
    name: []const u8,
    ahead: u32 = 0,
    behind: u32 = 0,
};

pub const Branches = struct {
    branch: []const u8 = "",
    names: []const Name = &.{},
};

/// The branch this checkout is on, and the ones a diff can be compared against with the distance to
/// each. Local branches come first, then a remote's copies; a folder that is not a repository has none.
pub fn branches(allocator: std.mem.Allocator, io: Io, cwd: []const u8) Branches {
    if (!isRepository(allocator, io, cwd)) return .{};
    const a = allocator;

    const out = git(a, io, cwd, &.{
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
        "refs/remotes",
    }, .limited(1 << 20)) catch return .{};
    const here = git(a, io, cwd, &.{ "branch", "--show-current" }, .limited(4096)) catch "";

    var list: std.ArrayList(Name) = .empty;
    var lines = std.mem.tokenizeScalar(u8, out, '\n');
    while (lines.next()) |ref| {
        const bare = if (std.mem.startsWith(u8, ref, "refs/heads/"))
            ref["refs/heads/".len..]
        else if (std.mem.startsWith(u8, ref, "refs/remotes/"))
            ref["refs/remotes/".len..]
        else
            continue;
        // A remote's own head names a branch that is already in the list.
        if (std.mem.endsWith(u8, bare, "/HEAD")) continue;
        if (list.items.len >= max_branches) break;
        const gap = aheadBehind(a, io, cwd, bare);
        list.append(a, .{ .name = bare, .ahead = gap.ahead, .behind = gap.behind }) catch break;
    }
    return .{ .branch = trim(here), .names = list.items };
}

const Lines = struct { added: u32 = 0, removed: u32 = 0 };

/// Lines added and lines removed, one entry per path, for the diff a base describes. Git's
/// `numstat` is read because its columns are numbers in every language, unlike its summary line.
/// A file no one has added yet has no entry, and a binary one counts as none.
fn lineCounts(allocator: std.mem.Allocator, io: Io, cwd: []const u8, base: Base) std.StringHashMap(Lines) {
    const argv: []const []const u8 = switch (base) {
        .working => &.{ "diff", "--numstat", "-z", "HEAD" },
        .staged => &.{ "diff", "--numstat", "-z", "--cached", "HEAD" },
        else => &.{ "diff", "--numstat", "-z", base.refName().? },
    };
    var counts = std.StringHashMap(Lines).init(allocator);
    const out = git(allocator, io, cwd, argv, .limited(8 << 20)) catch return counts;

    var fields = std.mem.splitScalar(u8, out, 0);
    while (fields.next()) |field| {
        if (field.len == 0) continue;
        var columns = std.mem.tokenizeScalar(u8, field, '\t');
        const added = columns.next() orelse continue;
        const removed = columns.next() orelse continue;
        const size = Lines{ .added = parseCount(added), .removed = parseCount(removed) };

        // A rename leaves the path out of the counts and names the two paths in fields of their
        // own; the list shows the file the change ended in, so that is the one to mark.
        const path = columns.next();
        if (path == null) {
            _ = fields.next() orelse break;
        }
        const name = path orelse fields.next() orelse break;
        counts.put(name, size) catch return counts;
    }
    return counts;
}

const Gap = struct { ahead: u32 = 0, behind: u32 = 0 };

/// How far this checkout stands from a ref: how far ahead of it, and how far behind it.
fn aheadBehind(allocator: std.mem.Allocator, io: Io, cwd: []const u8, ref: []const u8) Gap {
    const spec = std.fmt.allocPrint(allocator, "{s}...HEAD", .{ref}) catch return .{};
    const out = git(allocator, io, cwd, &.{ "rev-list", "--left-right", "--count", spec }, .limited(4096)) catch return .{};

    var parts = std.mem.tokenizeAny(u8, trim(out), " \t");
    return .{
        .behind = parseCount(parts.next() orelse "0"),
        .ahead = parseCount(parts.next() orelse "0"),
    };
}

pub const Collector = struct {
    allocator: std.mem.Allocator,
    files: std.ArrayList(FileStatus) = .empty,
    truncated: bool = false,

    fn add(self: *Collector, path: []const u8, display: []const u8, code: u8, staged: bool, untracked: bool) void {
        if (self.files.items.len >= max_status_files) {
            self.truncated = true;
            return;
        }
        const a = self.allocator;
        self.files.append(a, .{
            .path = a.dupe(u8, path) catch return,
            .display = a.dupe(u8, display) catch return,
            .status = codeText(code),
            .staged = staged,
            .untracked = untracked,
        }) catch {};
    }
};

/// Everything returned lives on `allocator`; the caller owns it as a block.
pub fn status(allocator: std.mem.Allocator, io: Io, cwd: []const u8, base: Base) Status {
    if (!isRepository(allocator, io, cwd)) {
        return .{ .base = base.text(), .label = base.label(), .errorMessage = not_a_repository };
    }
    const a = allocator;
    var result = Status{ .base = base.text(), .label = base.label() };

    if (git(a, io, cwd, &.{ "branch", "--show-current" }, .limited(4096))) |branch| {
        result.branch = trim(branch);
    } else |_| {}

    const counts = lineCounts(a, io, cwd, base);

    // What stands beside the branch belongs to the base the panel compares against: commits when it
    // is another branch, lines when it is the working tree or the index.
    switch (base) {
        .working, .staged => {
            var values = counts.valueIterator();
            while (values.next()) |size| {
                result.insertions += size.added;
                result.deletions += size.removed;
            }
        },
        else => {
            const gap = aheadBehind(a, io, cwd, base.refName().?);
            result.ahead = gap.ahead;
            result.behind = gap.behind;
        },
    }

    const argv: []const []const u8 = switch (base) {
        .working => &.{ "status", "--porcelain=v1", "-z", "--untracked-files=all" },
        .staged => &.{ "diff", "--name-status", "-z", "--cached", "HEAD" },
        else => &.{ "diff", "--name-status", "-z", base.refName().? },
    };

    var collector = Collector{ .allocator = a };
    if (git(a, io, cwd, argv, .limited(8 << 20))) |output| {
        switch (base) {
            .working => parsePorcelain(&collector, output),
            else => parseNameStatus(&collector, output),
        }
    } else |err| {
        result.errorMessage = @errorName(err);
        return result;
    }

    for (collector.files.items) |*file| {
        if (counts.get(file.path)) |size| {
            file.insertions = size.added;
            file.deletions = size.removed;
        }
    }

    result.files = collector.files.items;
    result.truncated = collector.truncated;
    return result;
}

fn parsePorcelain(collector: *Collector, output: []const u8) void {
    var fields = std.mem.splitScalar(u8, output, 0);
    while (fields.next()) |field| {
        if (field.len < 4) continue;
        const index = field[0];
        const worktree = field[1];
        const path = field[3..];

        var display = path;
        if (index == 'R' or index == 'C') {
            if (fields.next()) |origin| display = origin;
        }

        const untracked = index == '?' and worktree == '?';
        const code = if (worktree != ' ') worktree else index;
        const staged = index != ' ' and index != '?';
        collector.add(path, display, code, staged, untracked);
    }
}

/// `git diff --name-status -z` answers one field per NUL, so the letter and the path are separate
/// records: `M\0web/app.js\0`. A rename is three: `R100\0old\0new\0`.
fn parseNameStatus(collector: *Collector, output: []const u8) void {
    var fields = std.mem.splitScalar(u8, output, 0);
    while (fields.next()) |field| {
        if (field.len == 0) continue;
        const code = field[0];
        var path = fields.next() orelse return;

        var display = path;
        if (code == 'R' or code == 'C') {
            const origin = path;
            path = fields.next() orelse return;
            display = origin;
        }
        if (path.len == 0) continue;
        collector.add(path, display, code, true, false);
    }
}

/// `path` null means the whole worktree. A file that git does not track yet is diffed against
/// /dev/null, so the browser renders one kind of patch text.
pub fn diff(allocator: std.mem.Allocator, io: Io, cwd: []const u8, base: Base, path: ?[]const u8) Error![]u8 {
    const a = allocator;
    if (!isRepository(a, io, cwd)) return error.NotRepository;
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.append(a, "diff");
    try argv.append(a, "--no-ext-diff");
    try argv.append(a, "--no-color");
    switch (base) {
        .working => {},
        .staged => try argv.append(a, "--cached"),
        else => try argv.append(a, base.refName().?),
    }

    const untracked_new_file = base == .working and path != null and !tracked(a, io, cwd, path.?);
    if (untracked_new_file) {
        argv.clearRetainingCapacity();
        try argv.append(a, "diff");
        try argv.append(a, "--no-ext-diff");
        try argv.append(a, "--no-color");
        try argv.append(a, "--no-index");
        try argv.append(a, "/dev/null");
        try argv.append(a, path.?);
    } else if (path) |target| {
        try argv.append(a, "--");
        try argv.append(a, target);
    }

    return gitOutput(a, io, cwd, argv.items, .limited(max_diff_bytes));
}

fn tracked(allocator: std.mem.Allocator, io: Io, cwd: []const u8, path: []const u8) bool {
    const argv = [_][]const u8{ "ls-files", "--error-unmatch", "--", path };
    _ = git(allocator, io, cwd, &argv, .limited(1024)) catch return false;
    return true;
}

fn git(allocator: std.mem.Allocator, io: Io, cwd: []const u8, argv: []const []const u8, limit: Io.Limit) ![]u8 {
    return invoke(allocator, io, cwd, argv, limit, false);
}

fn gitOutput(allocator: std.mem.Allocator, io: Io, cwd: []const u8, argv: []const []const u8, limit: Io.Limit) Error![]u8 {
    return invoke(allocator, io, cwd, argv, limit, true);
}

fn invoke(allocator: std.mem.Allocator, io: Io, cwd: []const u8, argv: []const []const u8, limit: Io.Limit, allow_diff_exit: bool) Error![]u8 {
    var full: std.ArrayList([]const u8) = .empty;
    try full.append(allocator, "git");
    for (argv) |item| try full.append(allocator, item);

    const result = std.process.run(allocator, io, .{
        .argv = full.items,
        .cwd = .{ .path = cwd },
        .stdout_limit = limit,
        .stderr_limit = .limited(64 << 10),
    }) catch |err| switch (err) {
        error.StreamTooLong => return error.TooLarge,
        else => return error.GitFailed,
    };

    if (!result.term.success()) {
        const exited = result.term == .exited and result.term.exited == 1;
        if (!(allow_diff_exit and exited)) {
            allocator.free(result.stdout);
            return error.GitFailed;
        }
    }
    return result.stdout;
}

fn trim(text: []const u8) []const u8 {
    return std.mem.trim(u8, text, " \r\n\t");
}

fn short(sha: []const u8) []const u8 {
    return if (sha.len > 8) sha[0..8] else sha;
}

fn parseCount(text: []const u8) u32 {
    return std.fmt.parseInt(u32, text, 10) catch 0;
}

test "a name-status list pairs a letter with the path that follows it" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    var collector = Collector{ .allocator = arena.allocator() };
    parseNameStatus(&collector, "M\x00web/app.js\x00R100\x00old/name\x00new/name\x00");

    const files = collector.files.items;
    try std.testing.expectEqual(@as(usize, 2), files.len);
    try std.testing.expectEqualStrings("web/app.js", files[0].path);
    try std.testing.expectEqualStrings("M", files[0].status);
    try std.testing.expectEqualStrings("new/name", files[1].path);
    try std.testing.expectEqualStrings("old/name", files[1].display);
}

test "a porcelain list keeps the worktree letter and the untracked flag" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    var collector = Collector{ .allocator = arena.allocator() };
    parsePorcelain(&collector, " M web/app.js\x00?? src/new.zig\x00R  new/name\x00old/name\x00");

    const files = collector.files.items;
    try std.testing.expectEqual(@as(usize, 3), files.len);
    try std.testing.expectEqualStrings("web/app.js", files[0].path);
    try std.testing.expectEqualStrings("M", files[0].status);
    try std.testing.expect(!files[0].staged);
    try std.testing.expect(files[1].untracked);
    try std.testing.expectEqualStrings("new/name", files[2].path);
    try std.testing.expectEqualStrings("old/name", files[2].display);
}
