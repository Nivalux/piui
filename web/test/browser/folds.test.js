import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { blocked, page, sessionsDir, wiredProject, start, stop } from "./harness.mjs";

before(start);
after(stop);

test("folded bodies are empty and populate on demand with scroll position preserved", { skip: blocked }, async () => {
  const file = path.join(sessionsDir, "lazy-details.jsonl");
  const output = Array.from({ length: 200 }, (_, i) => `BODY_ONLY_OUTPUT_${i} ${"x".repeat(300)}`).join("\n");
  const messages = [
    { role: "user", content: [{ type: "text", text: "lazy detail fixture" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "thought preview\n\n**thought detail**" },
        { type: "toolCall", id: "lazy-job", name: "job_wait", arguments: { job: "j1" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "lazy-job",
      toolName: "job_wait",
      content: [{ type: "text", text: output }],
      details: { status: "exited", exitCode: 0 },
    },
    { role: "compactionSummary", summary: "compaction detail", tokensBefore: 1000 },
    { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
  ];
  fs.writeFileSync(
    file,
    [
      { type: "session", version: 3, id: "lazy-details", cwd: wiredProject, timestamp: new Date().toISOString() },
      ...messages.map((message, i) => ({
        type: "message",
        id: `lazy-${i}`,
        parentId: i ? `lazy-${i - 1}` : null,
        timestamp: new Date().toISOString(),
        message,
      })),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  await page.evaluate(async (session) => {
    const response = await fetch("/api/tab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session }),
    });
    const tab = await response.json();
    localStorage.setItem("piui:tab", tab.id);
  }, file);
  await page.reload();
  await page.waitForSelector("#transcript .block.tool");
  const bodies = page.locator("#transcript .fold-body");
  assert.equal(await bodies.count(), 3);
  assert.ok(
    (await bodies.evaluateAll((nodes) => nodes.map((node) => node.childElementCount))).every((count) => count === 0),
  );
  assert.doesNotMatch(await page.locator("#transcript").innerText(), /BODY_ONLY_OUTPUT/);
  const tool = page.locator("#transcript .block.tool");
  await tool.locator("summary").click();
  const pre = tool.locator(".pre");
  await pre.waitFor({ state: "visible" });
  assert.match(await pre.innerText(), /BODY_ONLY_OUTPUT_199/);
  const position = await pre.evaluate((node) => {
    node.scrollTop = 100;
    node.scrollLeft = 120;
    return { top: node.scrollTop, left: node.scrollLeft };
  });
  assert.ok(position.top > 0 && position.left > 0);
  await tool.locator("summary").click();
  await pre.waitFor({ state: "detached" });
  assert.equal(await tool.locator(".fold-body").evaluate((node) => node.childElementCount), 0);
  await tool.locator("summary").click();
  await pre.waitFor({ state: "visible" });
  assert.deepEqual(await pre.evaluate((node) => ({ top: node.scrollTop, left: node.scrollLeft })), position);
  const thought = page.locator("#transcript .block.thinking");
  await thought.locator("summary").click();
  await thought.locator(".thinking-body").waitFor({ state: "visible" });
  assert.match(await thought.locator(".thinking-body").innerText(), /thought detail/);
  const compaction = page.locator("#transcript .block.compaction");
  await compaction.locator("summary").click();
  await compaction.locator(".pre").waitFor({ state: "visible" });
  assert.equal(await compaction.locator(".pre").innerText(), "compaction detail");
});
