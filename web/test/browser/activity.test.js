import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { blocked, page, start, stop } from "./harness.mjs";

before(start);
after(stop);

test("activity ticker pauses when hidden, reduced or unused", { skip: blocked }, async () => {
  assert.ok(await page.evaluate(async () => (await document.fonts.load('14px "piui activity"', "⠋")).length > 0));
  await page.waitForFunction(
    () => [...document.querySelectorAll(".spinner")].every((node) => node.getBoundingClientRect().width === 0),
    undefined,
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    window.activityTimers = new Set();
    window.originalActivitySet = window.setInterval;
    window.originalActivityClear = window.clearInterval;
    window.setInterval = (...args) => {
      const id = window.originalActivitySet(...args);
      if (args[1] === 125) window.activityTimers.add(id);
      return id;
    };
    window.clearInterval = (id) => {
      window.activityTimers.delete(id);
      window.originalActivityClear(id);
    };
    const node = document.createElement("span");
    node.className = "spinner";
    node.id = "activity-test";
    node.style.cssText = "position:fixed;top:10px;left:10px";
    document.body.append(node);
  });
  try {
    await page.waitForFunction(() => window.activityTimers.size === 1);
    const first = await page.locator("#activity-test").textContent();
    await page.waitForFunction((first) => document.getElementById("activity-test")?.textContent !== first, first);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => window.activityTimers.size === 0);
    const hidden = await page.locator("#activity-test").textContent();
    await page.waitForTimeout(550);
    assert.equal(await page.locator("#activity-test").textContent(), hidden);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => window.activityTimers.size === 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => window.activityTimers.size === 0);
    assert.equal(await page.locator("#activity-test").textContent(), "⠋");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => window.activityTimers.size === 1);
    await page.locator("#activity-test").evaluate((node) => {
      node.style.top = "-100px";
    });
    await page.waitForFunction(() => window.activityTimers.size === 0);
    await page.locator("#activity-test").evaluate((node) => {
      node.style.top = "10px";
    });
    await page.waitForFunction(() => window.activityTimers.size === 1);
    await page.locator("#activity-test").evaluate((node) => {
      node.hidden = true;
    });
    await page.waitForFunction(() => window.activityTimers.size === 0);
    await page.locator("#activity-test").evaluate((node) => {
      node.hidden = false;
    });
    await page.waitForFunction(() => window.activityTimers.size === 1);
    await page.locator("#activity-test").evaluate((node) => node.remove());
    await page.waitForFunction(() => window.activityTimers.size === 0);
  } finally {
    await page.evaluate(() => {
      document.getElementById("activity-test")?.remove();
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
      window.setInterval = window.originalActivitySet;
      window.clearInterval = window.originalActivityClear;
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
});
