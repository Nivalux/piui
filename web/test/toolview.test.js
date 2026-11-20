import { test } from "node:test";
import assert from "node:assert/strict";
import { isKnownTool, jobBody, toolView } from "../toolview.js";

test("a read names the range it covered", () => {
  const view = toolView("read", { path: "/src/a.zig", offset: 10, limit: 3 }, "one\ntwo\nthree", null);

  assert.equal(view.hint, "3 lines");
  assert.deepEqual(view.chips, [
    { label: "path", value: "/src/a.zig" },
    { label: "lines", value: "10–12" },
    { label: "limit", value: "3" },
  ]);
  assert.equal(view.rows, null);
});

test("a shell call keeps its command in the row when it fits", () => {
  const view = toolView("bash", { command: "just test", timeout: 600 }, "ok\n", null);

  assert.equal(view.command, "", "the title already says the whole thing");
  assert.deepEqual(view.input, [{ label: "timeout", value: "600" }]);
});

test("a shell call nobody could read at a glance shows the whole command", () => {
  const command = `cd /cache/projects/piui && python3 - <<'EOF'\nprint("two lines")\nEOF`;
  const view = toolView("bash", { command, timeout: 640 }, "two lines\n", null);

  assert.equal(view.command, command, "what the summary cut has to be readable somewhere");
  assert.deepEqual(view.input, [{ label: "timeout", value: "640" }], "and is not repeated as a chip");
});

test("a job shows the command that started it", () => {
  const command = `node --test web/test/${"x".repeat(120)}.test.js`;
  const view = toolView("job_run", { command }, "status: ready\n", { status: "ready", exitCode: null });

  assert.equal(view.command, command);
});

test("an empty read says so instead of showing nothing", () => {
  const view = toolView("read", { path: "/tmp/empty.txt" }, "", null);
  assert.equal(view.hint, "empty");
});

test("a write nobody saw before is all additions", () => {
  const view = toolView("write", { path: "/tmp/a.txt", content: "one\ntwo\n" }, "", null, null);

  assert.equal(view.hint, "+2 −0", "the newline after the last line is not a line of its own");
  assert.equal(view.adds, 2);
  assert.equal(view.dels, 0);
  assert.deepEqual(
    (view.rows ?? []).map((row) => row.kind),
    ["add", "add"],
  );
});

test("a write over content the transcript already saw becomes a diff", () => {
  const before = "one\ntwo\nthree\n";
  const view = toolView("write", { path: "/tmp/a.txt", content: "one\nTWO\nthree\n" }, "", null, before);

  assert.equal(view.hint, "+1 −1");
  assert.deepEqual(
    (view.rows ?? []).map((row) => [row.kind, row.text]),
    [
      ["ctx", "one"],
      ["del", "two"],
      ["add", "TWO"],
      ["ctx", "three"],
    ],
  );
});

test("an edit uses the patch pi handed back", () => {
  const patch = [
    "--- /tmp/probe.txt",
    "+++ /tmp/probe.txt",
    "@@ -1,3 +1,3 @@",
    " line one",
    "-line two",
    "+line TWO",
    " line three",
  ].join("\n");

  const view = toolView(
    "edit",
    { path: "/tmp/probe.txt", edits: [{ oldText: "line two", newText: "line TWO" }] },
    "Successfully replaced 1 block(s) in /tmp/probe.txt.",
    { patch, diff: " 1 line one\n-2 line two\n+2 line TWO", firstChangedLine: 2 },
  );

  assert.equal(view.hint, "+1 −1");
  assert.deepEqual(view.chips, [
    { label: "path", value: "/tmp/probe.txt" },
    { label: "edits", value: "1" },
  ]);
  assert.deepEqual(
    (view.rows ?? []).map((row) => row.kind),
    ["hunk", "ctx", "del", "add", "ctx"],
  );
});

test("an edit without a patch falls back to counting the edits", () => {
  const view = toolView("edit", { path: "/tmp/a.txt", edits: [{}, {}] }, "ok", null);
  assert.equal(view.hint, "2 edits");
  assert.equal(view.rows, null);
});

test("a job shows status, exit code and log as chips", () => {
  const details = {
    job: "e37142",
    pid: 69370,
    status: "exited",
    outcome: "exited",
    logPath: "/tmp/pi-jobs/x/cd-3381bf.log",
    elapsedSec: 1.26,
    exitCode: 0,
  };
  const text =
    "status: exited code=0\nelapsed 1.3s · pid 69370 · job e37142\nlog /tmp/pi-jobs/x/cd-3381bf.log (78 bytes)\n\nfib 25 = 75025\n";

  const view = toolView("job_run", { command: "python3 x" }, text, details);

  assert.equal(view.hint, "exited 0");
  assert.deepEqual(view.chips, [
    { label: "status", value: "exited" },
    { label: "exit", value: "0" },
    { label: "elapsed", value: "1.3s" },
    { label: "pid", value: "69370" },
    { label: "job", value: "e37142" },
    { label: "log", value: "/tmp/pi-jobs/x/cd-3381bf.log" },
  ]);
  assert.equal(view.text, "fib 25 = 75025\n");
});

test("a job that is still running has no exit code to show", () => {
  const view = toolView(
    "job_run",
    {},
    'status: running — max wait reached\nelapsed 2.0s · pid 69983 · job f7e1aa\njob_wait { "job": "f7e1aa" } to keep waiting\n',
    { status: "running", outcome: "timeout", elapsedSec: 2, pid: 69983, job: "f7e1aa", exitCode: null },
  );

  assert.equal(view.hint, "running");
  assert.equal(view.text.includes("max wait reached"), true);
});

test("a job with no result yet claims no status", () => {
  const view = toolView("job_run", { command: "make" }, "", null);

  assert.equal(view.hint, "");
  assert.deepEqual(view.chips, []);
});

test("the job header lines are only kept when there is no details object", () => {
  const text = "status: exited code=0\n\nreal output\n";
  assert.equal(jobBody(text), "real output\n");
});

test("a job result that is nothing but headers keeps them rather than going blank", () => {
  const text = 'status: running — max wait reached\nelapsed 2.0s · pid 1 · job f7e1aa\njob_wait { "job": "f7e1aa" } to keep waiting\n';
  assert.equal(jobBody(text), text);
});

test("unknown tools keep their plain dump", () => {
  const view = toolView("grep", { pattern: "x" }, "3 matches", null);
  assert.equal(view.hint, "");
  assert.equal(view.text, "3 matches");
  assert.equal(view.rows, null);
});

test("only the known tools claim a shaped view", () => {
  assert.equal(isKnownTool("write"), true);
  assert.equal(isKnownTool("job_wait"), true);
  assert.equal(isKnownTool("grep"), false);
});
