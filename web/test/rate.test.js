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
