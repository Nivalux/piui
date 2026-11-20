const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const mod = b.addModule("piui", .{
        .root_source_file = b.path("piui.zig"),
        .target = target,
    });

    const exe = b.addExecutable(.{
        .name = "piui",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "piui", .module = mod }},
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

    const suite = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("tests.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "piui", .module = mod },
                .{ .name = "options", .module = options.createModule() },
            },
        }),
    });

    const test_step = b.step("test", "Run all tests: zig units, fuzz corpus, js logic, tsc");
    const run_suite = b.addRunArtifact(suite);
    run_suite.addPassthruArgs();
    test_step.dependOn(&run_suite.step);

    // The browser tests drive the built binary, so the binary has to exist by
    // the time node runs. Without chromium they skip themselves.
    const js = b.addSystemCommand(&.{ "node", "--test", "web/test/**/*.test.js" });
    js.step.dependOn(b.getInstallStep());
    test_step.dependOn(&js.step);

    const types = b.addSystemCommand(&.{ "tsc", "--project", "web" });
    test_step.dependOn(&types.step);
}
