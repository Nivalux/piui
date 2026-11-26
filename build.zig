const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const assets = b.createModule(.{ .root_source_file = webAssets(b), .target = target });

    const mod = b.addModule("piui", .{
        .root_source_file = b.path("piui.zig"),
        .target = target,
    });
    mod.addImport("web_assets", assets);

    const exe = b.addExecutable(.{
        .name = "piui",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "piui", .module = mod },
                .{ .name = "web_assets", .module = assets },
            },
        }),
    });
    b.installArtifact(exe);

    const run_step = b.step("run", "Run the server; extra args reach the binary");
    const run_cmd = b.addRunArtifact(exe);
    run_step.dependOn(&run_cmd.step);
    run_cmd.step.dependOn(b.getInstallStep());
    run_cmd.addPassthruArgs();

    const options = b.addOptions();
    options.addOption(u64, "fuzz_steps", b.option(u64, "fuzz", "steps of the random fuzz test") orelse 3000);

    const only = b.option([]const u8, "only", "run only the tests whose name contains this");

    const suite = b.addTest(.{
        .filters = if (only) |name| &.{name} else &.{},
        .root_module = b.createModule(.{
            .root_source_file = b.path("tests.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "piui", .module = mod },
                .{ .name = "options", .module = options.createModule() },
                .{ .name = "web_assets", .module = assets },
            },
        }),
    });

    const zig_step = b.step("test-zig", "Run the zig units and the fuzz replay, and nothing else");
    const run_suite = b.addRunArtifact(suite);
    run_suite.addPassthruArgs();
    zig_step.dependOn(&run_suite.step);

    const test_step = b.step("test", "Run all tests: zig units, fuzz corpus, js logic, tsc");
    test_step.dependOn(&run_suite.step);

    const js = b.addSystemCommand(&.{
        "node",
        "--test",
        "--test-timeout=25000",
        "--test-force-exit",
        "--test-concurrency=4",
        "web/test/**/*.test.js",
    });
    js.step.dependOn(b.getInstallStep());
    test_step.dependOn(&js.step);

    const types = b.addSystemCommand(&.{ "tsc", "--project", "web" });
    test_step.dependOn(&types.step);
}

/// The client files, as a Zig module of `{name, body}` pairs.
fn webAssets(b: *std.Build) std.Build.LazyPath {
    const alloc = b.allocator;

    var names: std.ArrayList([]const u8) = .empty;
    watchEntries(b, "web");
    collect(b, "web", "", &names) catch @panic("web/ cannot be read");
    std.mem.sort([]const u8, names.items, {}, lessByName);

    const staged = b.addWriteFiles();
    for (names.items) |name| {
        const source = std.fs.path.join(alloc, &.{ "web", name }) catch @panic("OOM");
        _ = staged.addCopyFile(b.path(source), name);
    }

    var text: std.ArrayList(u8) = .empty;
    append(&text, "// Generated from the web/ folder by build.zig. Do not edit.\n");
    append(&text, "pub const Entry = struct { name: []const u8, body: []const u8 };\n");
    append(&text, "pub const entries = [_]Entry{\n");

    for (names.items) |name| {
        append(&text, "    .{ .name = \"/");
        append(&text, name);
        append(&text, "\", .body = @embedFile(\"./");
        append(&text, name);
        append(&text, "\") },\n");
    }
    append(&text, "};\n");

    return staged.add("web_assets.zig", text.items);
}

fn lessByName(_: void, left: []const u8, right: []const u8) bool {
    return std.mem.order(u8, left, right) == .lt;
}

fn append(list: *std.ArrayList(u8), text: []const u8) void {
    list.appendSlice(std.heap.page_allocator, text) catch @panic("OOM");
}

fn collect(b: *std.Build, path: []const u8, prefix: []const u8, out: *std.ArrayList([]const u8)) !void {
    const io = b.graph.io;
    const alloc = b.allocator;

    var dir = try std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true });
    defer dir.close(io);

    var seen = dir.iterate();
    while (try seen.next(io)) |entry| {
        if (std.mem.eql(u8, entry.name, "test")) continue;
        const name = if (prefix.len == 0)
            try alloc.dupe(u8, entry.name)
        else
            try std.fs.path.join(alloc, &.{ prefix, entry.name });

        switch (entry.kind) {
            .directory => {
                const inner = try std.fs.path.join(alloc, &.{ path, entry.name });
                watchEntries(b, inner);
                try collect(b, inner, name, out);
            },
            .file => try out.append(alloc, name),
            else => {},
        }
    }
}

fn watchEntries(b: *std.Build, path: []const u8) void {
    b.dependOnDirectoryContents(b.path(path));
}
