// @ts-check

import { test } from "node:test";
import assert from "node:assert/strict";

import { Meter } from "../rate.js";

test("nothing is measured before a run starts", () => {
  const meter = new Meter();
  meter.addText("text that was replayed from disk");

  assert.equal(meter.running, false);
  assert.equal(meter.reading().tokensPerSecond, 0);
});

test("characters are an estimate until usage arrives", () => {
  const meter = new Meter();
  meter.start(0);
  meter.addText("x".repeat(80));

  const reading = meter.reading(1000);
  assert.equal(reading.exact, false);
  assert.equal(reading.tokens, 20);
  assert.equal(reading.tokensPerSecond, 20);
});

test("reported usage is the better number", () => {
  const meter = new Meter();
  meter.start(0);
  meter.addText("x".repeat(80));
  meter.addUsage({ input: 500, output: 120, cost: { total: 0.0142 } });

  const reading = meter.reading(2000);
  assert.equal(reading.exact, true);
  assert.equal(reading.tokens, 120);
  assert.equal(reading.tokensPerSecond, 60);
  assert.equal(meter.cost(), 0.0142);
});

test("a stopped run keeps its own average", () => {
  const meter = new Meter();
  meter.start(0);
  meter.addUsage({ output: 100 });
  meter.stop(1000);

  assert.equal(meter.running, false);
  assert.equal(meter.reading(60_000).tokensPerSecond, 100);
});

test("a new prompt restarts the meter", () => {
  const meter = new Meter();
  meter.start(0);
  meter.addUsage({ output: 900 });
  meter.start(5000);

  assert.equal(meter.reading(5000).tokens, 0);
});

test("the pace is the last few answers rather than the last second", () => {
  const meter = new Meter();

  meter.turn(100, 2_000);
  assert.equal(meter.pace(), 50);

  meter.turn(50, 500);
  assert.equal(meter.pace(), 60, "150 tokens over two and a half seconds");
});

test("a turn that wrote nothing is no evidence of speed", () => {
  const meter = new Meter();

  meter.turn(0, 9_000);
  meter.turn(10, 40);
  assert.equal(meter.pace(), 0);
});

test("only the last three answers are remembered", () => {
  const meter = new Meter();

  for (let turn = 0; turn < 5; turn += 1) meter.turn(100, 1_000);
  assert.equal(meter.pace(), 100);

  meter.turn(30, 1_000);
  assert.ok(Math.abs(meter.pace() - 230 / 3) < 0.01, "the two oldest have dropped out");
});

test("an opened chat knows its pace before anything new arrives", () => {
  const meter = new Meter();

  meter.history([
    { role: "user", content: "go", timestamp: 1_000 },
    { role: "assistant", content: "here", usage: { output: 200 }, timestamp: 3_000 },
    { role: "toolResult", content: "done", timestamp: 4_000 },
    { role: "assistant", content: "there", usage: { output: 100 }, timestamp: 6_000 },
  ]);

  assert.equal(meter.pace(), 75, "300 tokens over the four seconds the model had");
});

test("a new chat starts without the pace of the one before", () => {
  const meter = new Meter();

  meter.turn(200, 1_000);
  meter.reset();

  assert.equal(meter.pace(), 0);
  assert.equal(meter.cost(), 0);
});
