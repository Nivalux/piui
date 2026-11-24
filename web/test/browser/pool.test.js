import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const fake = `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
let file = process.argv[process.argv.indexOf("--session") + 1];
if (!process.argv.includes("--session")) file = null;
const send = f => process.stdout.write(JSON.stringify(f) + "\\n");
readline.createInterface({input:process.stdin}).on("line", line => {
 const c = JSON.parse(line);
 const reply = data => send({type:"response",id:c.id,command:c.type,success:true,data});
 if(c.type === "switch_session") {
  if(c.sessionPath.includes("cancel")) return reply({cancelled:true});
  if(!c.sessionPath.endsWith("wrong.jsonl")) file=c.sessionPath;
  return setTimeout(()=>reply({cancelled:false}),20);
 }
 if(c.type === "get_state") return reply({sessionFile:file,isStreaming:false});
 if(c.type === "get_messages") return reply({messages:[{role:"user",content:[{type:"text",text:JSON.stringify({file,pid:process.pid})}]}]});
 if(c.type === "prompt") {reply({});setTimeout(()=>send({type:"agent_start"}),20);return;}
 if(c.type === "abort") {send({type:"agent_settled"});return reply({});}
 reply({});
});
`;

test("the pool reuses settled workers, isolates prompts, and preserves tabs", { timeout: 45000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piui-pool-"));
  const pi = path.join(dir, "pi.mjs");
  fs.writeFileSync(pi, fake, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, "scratch"));
  const files = ["a", "b", "cancel", "wrong"].map((name) => {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: name, cwd: dir, timestamp: new Date().toISOString() })}\n`,
    );
    return file;
  });
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const token = "0".repeat(40);
  const server = spawn(
    process.env.PIUI_BINARY ?? path.resolve("zig-out/bin/piui"),
    [
      "--addr",
      `127.0.0.1:${port}`,
      "--token",
      token,
      "--pi",
      pi,
      "--sessions",
      dir,
      "--config",
      path.join(dir, "config.json"),
      "--scratch",
      path.join(dir, "scratch"),
      "--idle",
      "1",
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((resolve) => server.once("exit", resolve));
  let cookie = "";
  const request = async (url, body, method = body ? "POST" : "GET") => {
    const response = await fetch(base + url, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(response.ok, `${method} ${url}: ${response.status}`);
    return response;
  };
  const history = async (tab) => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);
    try {
      const response = await fetch(`${base}/api/events?id=${tab.id}`, { headers: { cookie }, signal: abort.signal });
      await request(`/api/cmd?id=${tab.id}`, { type: "get_messages" });
      let buffer = "";
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        buffer += new TextDecoder().decode(value);
        while (buffer.includes("\n")) {
          const newline = buffer.indexOf("\n");
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data: ")) continue;
          const frame = JSON.parse(line.slice(6));
          if (frame.command === "get_messages") return JSON.parse(frame.data.messages[0].content[0].text);
        }
      }
    } finally {
      clearTimeout(timeout);
      abort.abort();
    }
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const login = await request("/api/login", { token });
    cookie = login.headers.get("set-cookie").split(";")[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
    const open = async (session) => (await request("/api/tab", { cwd: dir, session })).json();
    const a = await open(files[0]);
    const first = await history(a);
    const b = await open(files[1]);
    const second = await history(b);
    assert.equal(second.pid, first.pid);
    assert.equal(second.file, files[1]);
    assert.deepEqual(await history(a), first);
    await request(`/api/cmd?id=${a.id}`, { type: "prompt", message: "hold" });
    assert.equal((await open(files[0])).id, a.id);
    const other = await history(b);
    assert.notEqual(other.pid, first.pid);
    assert.equal(other.file, files[1]);
    assert.deepEqual(await history(a), first);
    await request(`/api/cmd?id=${a.id}`, { type: "abort" });
    const cancelled = await open(files[2]);
    assert.equal((await history(cancelled)).file, files[2]);
    const wrong = await open(files[3]);
    assert.equal((await history(wrong)).file, files[3]);
    const tabs = await (await request("/api/tabs")).json();
    assert.ok(tabs.some((tab) => tab.id === a.id));
    assert.ok(tabs.some((tab) => tab.id === b.id));
    await request(`/api/tab?id=${b.id}`, undefined, "DELETE");
    const remaining = await (await request("/api/tabs")).json();
    assert.ok(remaining.some((tab) => tab.id === a.id));
    assert.ok(!remaining.some((tab) => tab.id === b.id));
    await new Promise((resolve) => setTimeout(resolve, 31000));
    const afterIdle = await (await request("/api/tabs")).json();
    assert.deepEqual(afterIdle.map((tab) => tab.id).sort(), remaining.map((tab) => tab.id).sort());
    assert.ok(afterIdle.every((tab) => !tab.closed));
    assert.equal((await history(a)).file, files[0]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "tabs.json"), "utf8"));
    assert.ok(saved.some((tab) => tab.session === files[0]));
    assert.ok(!saved.some((tab) => tab.session === files[1]));
  } finally {
    server.kill("SIGTERM");
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
