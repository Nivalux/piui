// @ts-check

/** Browser tests about panels. */

import { after, before, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import {
  blocked,
  chatId,
  crashes,
  git,
  gitOther,
  gitProject,
  noGit,
  openFreshChat,
  openProjectChat,
  page,
  runTurn,
  showPanel,
  start,
  stop,
  switchTo,
} from "./harness.mjs";

before(start);
after(stop);

/**
 * What the side panel shows right now. The side that is folded away leaves its
 * text out, so this asks about the one a reader can see.
 *
 * @returns {Promise<string>}
 */
async function panelText() {
  return page.evaluate(() => document.getElementById("side-panel")?.innerText ?? "");
}

test("both panels fold away and come back", { skip: blocked }, async () => {
  await showPanel(true);
  await showPanel(false);
  assert.ok(await page.locator("#panel-toggle").isVisible(), "the button that closed the panel stays reachable");

  await showPanel(true);

  await page.keyboard.press("Control+j");
  await page.waitForSelector("#side-panel", { state: "hidden" }, { timeout: 10000 });
  await page.keyboard.press("Control+j");
  await showPanel(true);

  await page.keyboard.press("Control+b");
  await page.waitForSelector("#shell.side-collapsed", { timeout: 10000 });
  await page.keyboard.press("Control+b");
  await page.waitForSelector("#shell:not(.side-collapsed)", { timeout: 10000 });

  await page.click("#sidebar-toggle");
  await page.waitForSelector("#shell.side-collapsed");
  await page.waitForSelector("#tab-list", { state: "hidden" });
  assert.ok(await page.locator("#sidebar-toggle").isVisible(), "and the same for the chat list");
  const widened = await page.evaluate(() => document.getElementById("transcript")?.clientWidth ?? 0);

  await page.click("#sidebar-toggle");
  await page.waitForSelector("#shell:not(.side-collapsed)");
  await page.waitForSelector("#tab-list .tab");
  const back = await page.evaluate(() => document.getElementById("transcript")?.clientWidth ?? 0);
  assert.ok(back < widened, "the chat gives the width back when the list returns");
});

test("the diff tab reads like git status and opens a patch beside the chat", { skip: blocked || noGit }, async () => {
  await openProjectChat(gitProject);
  await showPanel(true);
  await page.waitForFunction(() => document.querySelectorAll("#diff-body .st-row").length > 0, undefined, {
    timeout: 30000,
  });

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#diff-body .st-row")].map((row) => {
      const code = /** @type {HTMLElement} */ (row.querySelector(".st-code"));
      const marks = [...row.querySelectorAll(".st-lines span")].map((mark) => mark.textContent).join(" ");
      const path = row.querySelector(".st-path")?.textContent;
      return `${code?.textContent} ${code?.className.replace("st-code st-", "")} ${path}${marks.length > 0 ? ` ${marks}` : ""}`;
    }),
  );
  assert.ok(rows.includes("M mod notes.md +1"), `the edit carries the lines it changed: ${rows.join(", ")}`);
  assert.ok(rows.includes("? new fresh.md"), `what git never saw is listed as new: ${rows.join(", ")}`);

  const groups = (await page.locator("#diff-body .status-group").allInnerTexts())
    .map((/** @type {string} */ text) => text.trim().toLowerCase())
    .filter((/** @type {string} */ text) => text.length > 0);
  assert.deepEqual(groups, ["changes", "untracked"], "the two blocks `git status` would print");

  // What the diff is compared to only means something here, so the choice
  // lives with the tab rather than at the top of the window.
  assert.ok(await page.locator("#base").isVisible(), "the base sits inside the panel");
  assert.ok(await page.locator("#panel-files-tab").isVisible());

  await page.locator("#diff-body .st-row", { hasText: "notes.md" }).click();
  await page.waitForFunction(() => !document.getElementById("file-view")?.hasAttribute("hidden"));

  const tabs = (await page.locator("#view-tabs .view-tab").allInnerTexts()).map((/** @type {string} */ text) =>
    text.trim(),
  );
  assert.equal(tabs.length, 2, "the patch sits next to the chat");
  assert.equal(tabs[1], "Δ notes.md");
  assert.ok(await page.locator("#composer").isHidden(), "a patch is not a place to send a message");

  await page.waitForFunction(() => document.querySelectorAll("#file-body .row").length > 0);
  const patch = await page.evaluate(() => ({
    added: [...document.querySelectorAll("#file-body .row.add .code")].map((cell) => cell.textContent),
    removed: [...document.querySelectorAll("#file-body .row.del .code")].map((cell) => cell.textContent),
    head: document.querySelector("#file-head .file-meta")?.textContent,
  }));
  assert.deepEqual(patch.added, ["two"], "only the new line is added");
  assert.deepEqual(patch.removed, [], "nothing was taken away");
  assert.equal(patch.head, "+1 −0");

  await page.locator("#view-tabs .view-tab").first().click();
  await page.waitForFunction(() => !document.getElementById("composer")?.hasAttribute("hidden"));
  assert.ok(await page.locator("#transcript").isVisible(), "and the chat is where it was");
});

test("a chat still reading its own git says so instead of wearing the one before it", {
  skip: blocked || noGit,
}, async () => {
  await openProjectChat(gitProject);
  await showPanel(true);
  await page.waitForFunction(() => document.getElementById("branch")?.hidden === false, undefined, {
    timeout: 30000,
  });
  const branch = (await page.locator("#branch").innerText()).trim().split(/\s+/)[0];
  assert.ok(branch.length > 0, "the repository names itself before the switch");

  await page.route("**/api/git/status**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue().catch(() => {});
  });

  try {
    await openFreshChat();
    const whileWaiting = await page.evaluate(() => ({
      base: document.getElementById("base")?.textContent ?? "",
      chipShown: document.getElementById("branch")?.hidden !== true,
      foot: document.querySelector("#tab-list .tab.active .path")?.textContent ?? "",
    }));
    assert.ok(
      await page.locator("#diff-body .panel-wait").isVisible(),
      "the panel says it is reading rather than listing the last folder",
    );
    assert.ok(!whileWaiting.chipShown, "a folder whose git is not in yet does not name a branch");
    assert.equal(whileWaiting.base, "reading", "the base waits for the folder it belongs to");
    assert.notEqual(whileWaiting.foot, branch, "the row of the new chat does not wear the old branch");
    assert.ok(whileWaiting.foot.length > 0, "and it still says where the chat is");
  } finally {
    await page.unroute("**/api/git/status**");
  }

  await page.waitForFunction(() => document.querySelector("#diff-body .panel-wait") === null, undefined, {
    timeout: 30000,
  });
});

test("the folder side of the panel belongs to the chat on screen just as much", {
  skip: blocked || noGit,
}, async () => {
  await openProjectChat(gitProject);
  await showPanel(true);
  await page.click("#panel-files-tab");
  await page.waitForFunction(
    () => [...document.querySelectorAll("#file-list .file-row")].some((row) => row.textContent?.includes("notes.md")),
    undefined,
    { timeout: 30000 },
  );

  const slow = async (/** @type {any} */ route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue().catch(() => {});
  };
  await page.route("**/api/git/status**", slow);
  await page.route("**/api/files**", slow);

  try {
    await openFreshChat();
    const whileWaiting = await page.evaluate(() => ({
      wait: document.querySelector("#file-list .panel-wait") !== null,
      rows: [...document.querySelectorAll("#file-list .file-row")].map((row) => row.textContent ?? ""),
      crumbs: document.getElementById("file-crumbs")?.hidden !== true,
      chipShown: document.getElementById("branch")?.hidden !== true,
    }));
    assert.ok(whileWaiting.wait, "the listing says it is reading the folder of this chat");
    assert.deepEqual(whileWaiting.rows, [], `no row of the folder before it: ${whileWaiting.rows.join(", ")}`);
    assert.ok(!whileWaiting.crumbs, "and no trail of folders from that one");
    assert.ok(!whileWaiting.chipShown, "the title bar names no branch until the read is in");
  } finally {
    await page.unroute("**/api/git/status**");
    await page.unroute("**/api/files**");
  }

  await page.waitForFunction(() => document.querySelector("#file-list .panel-wait") === null, undefined, {
    timeout: 30000,
  });
});

test("a chat that takes over the screen takes its folder into the panel with it", {
  skip: blocked || noGit,
}, async () => {
  await openProjectChat(gitProject);
  await showPanel(true);
  const home = await chatId();
  await page.waitForFunction(
    () => (document.getElementById("side-panel")?.innerText ?? "").includes("fresh.md"),
    undefined,
    { timeout: 30000 },
  );

  const slow = async (/** @type {any} */ route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue().catch(() => {});
  };
  await page.route("**/api/git/status**", slow);
  await page.route("**/api/files**", slow);
  try {
    await openProjectChat(gitOther);
    const away = await panelText();
    assert.ok(
      !away.includes("fresh.md") && !away.includes("notes.md"),
      `the new chat wore the folder before it:\n${away}`,
    );

    await page.click("#panel-files-tab");
    const listing = await panelText();
    assert.ok(
      !listing.includes("keep.txt") && !listing.includes("notes.md"),
      `the folder side still held the chat before it:\n${listing}`,
    );

    await switchTo(home);
    const back = await panelText();
    assert.ok(
      !back.includes("stranger.md") && !back.includes("abroad.md"),
      `the chat came back to the folder of the one it left:\n${back}`,
    );
  } finally {
    await page.unroute("**/api/git/status**");
    await page.unroute("**/api/files**");
    await page.click("#panel-diff-tab");
  }

  await page.waitForFunction(
    () => (document.getElementById("side-panel")?.innerText ?? "").includes("fresh.md"),
    undefined,
    { timeout: 30000 },
  );

  await openProjectChat(gitOther);
  await page.waitForFunction(
    () => (document.getElementById("side-panel")?.innerText ?? "").includes("stranger.md"),
    undefined,
    { timeout: 30000 },
  );
  const there = await panelText();
  assert.ok(!there.includes("fresh.md"), `the other folder still showed through:\n${there}`);
  assert.match(await branchName(), /trunk/, "the badges name the branch of the folder on screen");

  await switchTo(home);
  await page.waitForFunction(
    () => (document.getElementById("side-panel")?.innerText ?? "").includes("fresh.md"),
    undefined,
    { timeout: 30000 },
  );
  assert.match(await branchName(), /main/, "and they change back with the folder");
});

test("two chats in one folder keep their panel between them instead of blanking it", {
  skip: blocked || noGit,
}, async () => {
  await openProjectChat(gitProject);
  const home = await chatId();
  await showPanel(true);
  await page.waitForFunction(
    () => (document.getElementById("side-panel")?.innerText ?? "").includes("fresh.md"),
    undefined,
    { timeout: 30000 },
  );

  await openProjectChat(gitProject);
  assert.ok(
    (await panelText()).includes("fresh.md"),
    "a chat in the folder already on screen does not throw its listing away",
  );

  await switchTo(home);
  assert.ok((await panelText()).includes("fresh.md"), "and neither does the way back");
});

/** @returns {Promise<string>} */
async function branchName() {
  return page.evaluate(() => document.getElementById("branch")?.innerText ?? "");
}

test("a file that answers late is read for the chat it was asked of, not the one on screen", {
  skip: blocked || noGit,
}, async () => {
  await openProjectChat(gitProject);
  const home = await chatId();
  await showPanel(true);
  await page.click("#panel-files-tab");
  await notesRow();

  let late = false;
  await page.route("**/api/file**", async (route) => {
    const first = new URL(route.request().url()).searchParams.get("id") === home;
    if (first) await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue().catch(() => {});
    if (first) late = true;
  });

  try {
    await page.locator("#file-list .file-row", { hasText: "notes.md" }).first().click();

    await openProjectChat(gitOther);
    await page.click("#panel-files-tab");
    await notesRow();
    await page.locator("#file-list .file-row", { hasText: "notes.md" }).first().click();

    await page.waitForFunction(
      () => (document.getElementById("file-view")?.innerText ?? "").includes("git-other"),
      undefined,
      { timeout: 30000 },
    );

    const until = Date.now() + 15000;
    while (!late && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(late, "the read of the chat that was left behind never came back to be tested");
    await page.waitForTimeout(500);

    const shown = await page.evaluate(() => document.getElementById("file-view")?.innerText ?? "");
    assert.ok(!shown.includes("git-project"), `the patch of a chat long gone took the screen:\n${shown.slice(0, 160)}`);
  } finally {
    await page.unroute("**/api/file**");
  }

  /** Wait until the folder side offers the file both projects keep under the same name. */
  async function notesRow() {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#file-list .file-row .file-name")].some(
          (name) => name.textContent === "notes.md",
        ),
      undefined,
      { timeout: 30000 },
    );
  }
});

test("a patch that answers late is read for the chat it was asked of, not the one on screen", {
  skip: blocked || noGit,
}, async () => {
  await openProjectChat(gitProject);
  const home = await chatId();
  await showPanel(true);
  await page.click("#panel-diff-tab");
  await changedNotes();

  let late = false;
  await page.route("**/api/git/diff**", async (route) => {
    const first = new URL(route.request().url()).searchParams.get("id") === home;
    if (first) await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.continue().catch(() => {});
    if (first) late = true;
  });

  try {
    await page.locator("#diff-body .st-row", { hasText: "notes.md" }).first().click();

    await openProjectChat(gitOther);
    await page.click("#panel-diff-tab");
    await changedNotes();
    await page.locator("#diff-body .st-row", { hasText: "notes.md" }).first().click();
    await page.waitForFunction(
      () => (document.getElementById("file-view")?.innerText ?? "").includes("only-in-the-other-folder"),
      undefined,
      { timeout: 30000 },
    );

    const until = Date.now() + 20000;
    while (!late && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(late, "the patch of the chat that was left behind never came back to be tested");
    await page.waitForTimeout(500);

    const shown = await page.evaluate(() => document.getElementById("file-view")?.innerText ?? "");
    assert.ok(
      shown.includes("only-in-the-other-folder"),
      `a patch from elsewhere replaced this one:\n${shown.slice(0, 160)}`,
    );
    assert.ok(!shown.includes("two"), `the patch of a chat long gone took the screen:\n${shown.slice(0, 160)}`);
  } finally {
    await page.unroute("**/api/git/diff**");
  }

  /** Wait until the diff side offers the file both projects keep under the same name. */
  async function changedNotes() {
    await page.waitForFunction(
      () => [...document.querySelectorAll("#diff-body .st-row")].some((row) => row.textContent?.includes("notes.md")),
      undefined,
      { timeout: 30000 },
    );
  }
});

test("the branch sits in the title bar and both places pick the same base", { skip: blocked || noGit }, async () => {
  const open = await page.locator("#tab-list .tab").count();
  await openProjectChat(gitProject);

  fs.writeFileSync(path.join(gitProject, "notes.md"), "one\ntwo\n");
  git(gitProject, ["branch", "release"]);
  git(gitProject, ["add", "-A"]);
  git(gitProject, ["commit", "-qm", "two lines"]);
  git(gitProject, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(gitProject, ["update-ref", "refs/remotes/origin/HEAD", "HEAD"]);

  const chat = await chatId();
  await page.reload();
  await switchTo(chat);

  const chip = () =>
    page.locator("#branch").evaluate((/** @type {HTMLElement} */ node) => ({
      parts: [...node.childNodes].map((part) => part.textContent ?? ""),
      base: node.title.split(" · ")[0] ?? "",
    }));

  await page.waitForFunction(
    () => {
      const chip = document.getElementById("branch");
      return chip !== null && !chip.hidden && chip.childNodes.length === 1;
    },
    undefined,
    { timeout: 30000 },
  );
  assert.deepEqual(await chip(), { parts: ["main"], base: "Working changes" }, "the branch of the chat, on the right");

  await page.click("#branch");
  await page.waitForSelector('.base-option[data-base^="branch:"]');
  const bases = await page
    .locator(".base-option")
    .evaluateAll((/** @type {HTMLElement[]} */ rows) => rows.map((row) => row.dataset.base ?? ""));

  assert.deepEqual(bases.slice(0, 2), ["working", "staged"], "the two that are always there come first");
  assert.ok(bases.includes("branch:release"), "then the branches of this repository");
  assert.ok(bases.includes("branch:origin/main"), "then a remote's copy of one");
  assert.ok(!bases.includes("branch:origin/HEAD"), "a remote's own head is not something to compare against");

  await page.fill(".base-filter", "release");
  assert.deepEqual(
    await page
      .locator(".base-option")
      .evaluateAll((/** @type {HTMLElement[]} */ rows) => rows.map((row) => row.textContent)),
    ["release"],
    "a filter leaves what it matches",
  );

  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".base-menu").count(), 0, "escape closes the list");

  await page.click("#base");
  await page.waitForSelector(".base-menu");
  await page.locator('.base-option[data-base="branch:release"]').click();
  await page.waitForFunction(() => document.getElementById("base")?.textContent === "release", undefined, {
    timeout: 30000,
  });
  assert.deepEqual(
    await chip(),
    { parts: ["main", "+1"], base: "release" },
    "the same answer, counted against that base",
  );

  await page.click("#branch");
  await page.waitForSelector(".base-menu");
  await page.locator('.base-option[data-base="working"]').click();
  await page.waitForFunction(
    () => (document.getElementById("branch")?.title ?? "").startsWith("Working changes"),
    undefined,
    { timeout: 30000 },
  );
  assert.deepEqual(await chip(), { parts: ["main"], base: "Working changes" }, "and back again");

  fs.writeFileSync(path.join(gitProject, "notes.md"), "one\nTWO\nthree\n");
  await page.click("#base");
  await page.waitForSelector(".base-menu");
  await page.locator('.base-option[data-base="staged"]').click();
  await page.waitForFunction(
    () => (document.getElementById("base")?.textContent ?? "") === "Staged changes",
    undefined,
    {
      timeout: 30000,
    },
  );
  assert.deepEqual(
    await chip(),
    { parts: ["main"], base: "Staged changes" },
    "nothing is staged, so nothing was added or removed",
  );

  await page.click("#base");
  await page.waitForSelector(".base-menu");
  await page.locator('.base-option[data-base="working"]').click();
  await page.waitForFunction(() => (document.getElementById("branch")?.textContent ?? "").includes("+2"), undefined, {
    timeout: 30000,
  });
  assert.deepEqual(
    await chip(),
    { parts: ["main", "+2", "−1"], base: "Working changes" },
    "with working changes the counts are the lines that changed, not commits to a remote",
  );

  await page.click("#kill");
  await page.waitForFunction(
    (/** @type {number} */ want) => document.querySelectorAll("#tab-list .tab").length === want,
    open,
    { timeout: 30000 },
  );
});

test("the panel never covers the chat", { skip: blocked || noGit }, async () => {
  await openProjectChat(gitProject);
  await page.evaluate(() => document.getElementById("shell")?.classList.remove("side-collapsed"));
  await showPanel(true);
  await page.waitForFunction(() => document.querySelectorAll("#diff-body .st-row").length > 0, undefined, {
    timeout: 30000,
  });

  const boxes = await page.evaluate(() => {
    /** @param {string} selector */
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { left: Math.round(box.left), right: Math.round(box.right) };
    };
    return {
      panel: rect("#side-panel"),
      center: rect(".center"),
      stream: rect("#stream"),
      composer: rect("#composer"),
      window: { right: window.innerWidth },
    };
  });

  assert.ok(boxes.panel && boxes.center && boxes.stream && boxes.composer, "every box is on the page");
  const edge = /** @type {number} */ (/** @type {any} */ (boxes.panel).left);
  assert.ok(
    /** @type {any} */ (boxes.center).right <= edge + 1,
    `the middle stops where the panel starts: ${JSON.stringify(boxes)}`,
  );
  for (const name of ["stream", "composer"]) {
    assert.ok(
      /** @type {any} */ (boxes[name]).right <= edge + 1,
      `${name} does not reach under the panel: ${JSON.stringify(boxes)}`,
    );
  }
  assert.ok(boxes.window.right - edge > 200, "the panel keeps its own room");
});

test("the files tab lists the folder and opens what is clicked", { skip: blocked || noGit }, async () => {
  await showPanel(true);
  await page.click("#panel-files-tab");
  await page.waitForSelector("#file-list .file-row");

  const names = async () =>
    await page.evaluate(() =>
      [...document.querySelectorAll("#file-list .file-row .file-name")].map((n) => n.textContent),
    );

  assert.ok((await names()).includes("keep.txt"));
  assert.ok((await names()).includes("fresh.md"), "a file git never saw is listed too");
  assert.ok((await names()).includes("sub"), "a folder is a row of its own");
  assert.ok(!(await names()).includes("nested.md"), "what is inside it waits until the folder is opened");

  await page.locator("#file-list .file-row", { hasText: "sub" }).click();
  await page.waitForFunction(() => document.getElementById("file-crumbs")?.hidden === false);
  assert.deepEqual(await names(), ["..", "nested.md"], "one folder deep, with a way back");

  await page.locator("#file-crumbs .crumb-up").click();
  await page.waitForFunction(
    () => ![...document.querySelectorAll(".file-row .file-name")].some((n) => n.textContent === ".."),
  );

  await page.fill("#file-filter", "ee");
  await page.waitForFunction(() => document.querySelectorAll("#file-list .file-row").length === 2);
  const narrowed = await page.evaluate(() =>
    [...document.querySelectorAll("#file-list .file-row .file-name")].map((n) => n.textContent),
  );
  assert.deepEqual(narrowed, ["keep.txt", "nested.md"], "typing searches the whole tree, near ones first");
  const dirs = await page.evaluate(() =>
    [...document.querySelectorAll("#file-list .file-row")].map(
      (row) => row.querySelector(".file-dir")?.textContent ?? "",
    ),
  );
  assert.deepEqual(dirs, ["", "sub"], "a file says where it lives only when that is not here");
  assert.ok(
    await page.evaluate(() => document.querySelector("#file-list .file-row .file-name mark") !== null),
    "the letters that matched are the ones typed",
  );

  await page.fill("#file-filter", "");
  await page.waitForFunction(() => document.querySelectorAll("#file-list .file-row").length > 1);
  await page.locator("#file-list .file-row", { hasText: "fresh.md" }).first().click();
  await page.locator("#file-list .file-row", { hasText: "notes.md" }).click();

  const labels = async () =>
    (await page.locator("#view-tabs .view-tab").allInnerTexts()).map((/** @type {string} */ text) => text.trim());

  assert.deepEqual(await labels(), ["git-project", "notes.md"], "clicking through a list reuses one tab");
  assert.ok(
    await page.evaluate(() => document.querySelector("#view-tabs .view.on .view-tab.preview") !== null),
    "the borrowed tab says so in italic",
  );

  await page.locator("#view-tabs .view.on .view-tab").click();
  assert.ok(
    await page.evaluate(() => document.querySelector("#view-tabs .view-tab.preview") === null),
    "clicking the tab is what keeps the file",
  );

  await page.locator("#file-list .file-row", { hasText: "keep.txt" }).click();
  assert.deepEqual(
    await labels(),
    ["git-project", "notes.md", "keep.txt"],
    "with nothing on loan, the next file gets a tab of its own",
  );

  await page.waitForFunction(() => document.querySelectorAll("#file-body .code-line").length >= 1);
  const read = await page.evaluate(() => ({
    lines: [...document.querySelectorAll("#file-body .code-line .lc")].map((cell) => cell.textContent),
    patch: document.querySelectorAll("#file-body .row").length,
  }));
  assert.deepEqual(read.lines, ["keep me"], "the whole file, not a piece of it");
  assert.equal(read.patch, 0, "a file from the folder is the file, not its diff");

  await page.locator("#view-tabs .view").nth(2).locator(".view-tab").click({ button: "middle" });
  await page.waitForFunction(() => document.querySelectorAll("#view-tabs .view").length === 2, undefined, {
    timeout: 10000,
  });

  for (let at = await page.locator("#view-tabs .view").count(); at > 1; at -= 1) {
    await page
      .locator("#view-tabs .view")
      .nth(at - 1)
      .locator(".view-close")
      .click();
  }
  await page.waitForFunction(() => document.querySelectorAll("#view-tabs .view").length === 1);
  await page.waitForFunction(() => !document.getElementById("composer")?.hasAttribute("hidden"));

  await page.keyboard.press("Escape");
  await page.waitForSelector("#side-panel", { state: "hidden" }, { timeout: 10000 });
  await showPanel(true);
});

test("the diff panel notices a turn that changed the folder", { skip: blocked || noGit }, async () => {
  await openProjectChat(gitProject);
  await showPanel(true);
  await page.click("#panel-diff-tab");
  await page.waitForFunction(() => (document.getElementById("panel-diff-tab")?.getBoundingClientRect().width ?? 0) > 0);
  await page.waitForFunction(() => document.querySelectorAll("#diff-body .st-row").length > 0);
  const listed = () =>
    page.evaluate(() => [...document.querySelectorAll("#diff-body .st-row .st-path")].map((p) => p.textContent));
  assert.ok(!(await listed()).includes("log.txt"), "the note is not there yet");

  await runTurn("scrawl a note");

  await page.waitForFunction(
    () => [...document.querySelectorAll("#diff-body .st-row .st-path")].some((p) => p.textContent === "log.txt"),
    undefined,
    { timeout: 30000 },
  );
});

test("a picture joins the message from the folder or from a drag", { skip: blocked }, async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAUCAYAAADskT9PAAAANUlEQVR4nGN4kOP1Hx4WEZXCiynVzzDqgFEHjDqA1hYQ0j/qgFEHjDph4MuBUQeMOmCgHQAARi3M/RQC5ogAAAAASUVORK5CYII=";
  const picture = path.join(os.tmpdir(), "piui-picture.png");
  fs.writeFileSync(picture, png, "base64");

  /**
   * @param {string} name
   * @param {string} type
   */
  const drop = (name, type) =>
    page.evaluate(
      /** @param {{name: string, type: string}} given */
      (given) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new TextEncoder().encode("something")], given.name, { type: given.type }));
        document
          .getElementById("composer")
          ?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
      },
      { name, type },
    );

  await openFreshChat();

  await page.setInputFiles("#attach-input", picture);
  await page.waitForSelector("#attachments .attachment img");
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector("#attachments .attachment img")?.getAttribute("src")?.startsWith("data:image/png") ??
        false,
    ),
    "the picked picture is there to look at before it is sent",
  );

  await drop("dropped.png", "image/png");
  await page.waitForFunction(() => document.querySelectorAll("#attachments .attachment").length === 2);

  await drop("notes.txt", "text/plain");
  await page.waitForFunction(() => document.querySelector("#attachments .attach-note") !== null);
  assert.equal(
    await page.evaluate(() => document.querySelectorAll("#attachments .attachment").length),
    2,
    "a file that cannot go to pi is said so rather than dropped on the floor",
  );

  for (let at = 0; at < 2; at += 1) {
    await page.locator("#attachments .attachment .button").first().click();
  }
  assert.equal(await page.locator("#attachments .attachment").count(), 0, "both chips came back off");
  assert.equal(
    await page.locator("#attachments .attach-note").count(),
    1,
    "the note about the file that was refused stays where it can be read",
  );
});

test("the counters sit in their own band above the editor, even when narrow", { skip: blocked }, async () => {
  await openFreshChat();
  await runTurn("run the scripted tools");

  await page.setViewportSize({ width: 420, height: 900 });
  try {
    // The band only takes a line when it has something to say.
    await page.waitForFunction(() => document.getElementById("meter-bar")?.hidden === false, null, {
      timeout: 10000,
    });

    /** Where the counters, the editor and its buttons ended up. */
    const edges = await page.evaluate(() => {
      /** @param {string} sel */
      const box = (sel) => {
        const node = /** @type {HTMLElement | null} */ (document.querySelector(sel));
        if (!node) throw new Error(`no ${sel}`);
        return node.getBoundingClientRect();
      };
      return {
        view: window.innerWidth,
        meterTop: box("#meter-bar").top,
        meterBottom: box("#meter-bar").bottom,
        meterLeft: box("#meter-bar").left,
        composerTop: box("#composer").top,
        modelBottom: box("#model").bottom,
        sendLeft: box("#send").left,
        sendRight: box("#send").right,
        attachLeft: box("#attach").left,
        attachRight: box("#attach").right,
      };
    });

    assert.ok(edges.attachLeft >= 0 && edges.attachRight <= edges.view, "attach is inside the window");
    assert.ok(edges.sendLeft >= 0 && edges.sendRight <= edges.view, "send is inside the window");
    assert.ok(edges.meterBottom <= edges.composerTop + 1, "the counters are above the editor");
    assert.ok(edges.meterLeft >= 0, "and none of them hangs off the left edge");
    assert.ok(edges.modelBottom > edges.meterBottom, "the pickers stayed in the editor, below them");
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page
      .waitForFunction(() => !document.getElementById("shell")?.classList.contains("tight"), null, { timeout: 5000 })
      .catch(() => {});
  }
});

test("a window too narrow for both gives the chat the pixels", { skip: blocked }, async () => {
  // The setting decides, not the current fold: a window that is holding the
  // panel out on its own must not be answered with a click that closes it for
  // good, which is exactly what a click on the toggle would do then.
  await page.evaluate(() => {
    if (document.getElementById("side-panel")?.hidden) document.getElementById("panel-toggle")?.click();
  });
  await page.waitForFunction(
    () =>
      document.getElementById("side-panel")?.hidden === false &&
      !document.getElementById("shell")?.classList.contains("tight"),
    null,
    { timeout: 10000 },
  );

  const wide = await page.evaluate(() => ({
    panel: document.querySelector("#side-panel")?.clientWidth ?? 0,
    work: document.querySelector("#work")?.clientWidth ?? 0,
  }));
  assert.ok(wide.panel > 200, "the panel is out at a normal width");

  await page.setViewportSize({ width: 760, height: 900 });
  try {
    await page.waitForFunction(
      () => {
        const at = document.getElementById("side-panel");
        return at ? getComputedStyle(at).display === "none" : true;
      },
      null,
      { timeout: 5000 },
    );
    const chat = await page.evaluate(() => ({
      work: document.querySelector("#work")?.clientWidth ?? 0,
      composer: document.querySelector("#composer")?.clientWidth ?? 0,
    }));
    assert.ok(chat.work < wide.work, "the window really did get smaller");
    assert.ok(chat.composer >= chat.work - 2, "and the chat kept the whole row, panel or no panel");
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }

  await page.waitForFunction(
    () => {
      const at = document.getElementById("side-panel");
      return at ? getComputedStyle(at).display !== "none" : false;
    },
    null,
    { timeout: 5000 },
  );
});

test("a short title bar takes room off the title, not off the branch counts", { skip: blocked || noGit }, async () => {
  git(gitProject, ["add", "-A"]);
  git(gitProject, ["commit", "-qm", "a clean base for the badge"]);
  fs.writeFileSync(path.join(gitProject, "notes.md"), "alpha\nbeta\n");

  await openProjectChat(gitProject);
  await page.waitForFunction(
    () => {
      const chip = document.getElementById("branch");
      return chip !== null && !chip.hidden && chip.childNodes.length === 3;
    },
    undefined,
    { timeout: 30000 },
  );

  await page.setViewportSize({ width: 700, height: 800 });
  try {
    const badge = await page.locator("#branch").evaluate((/** @type {HTMLElement} */ node) => ({
      parts: [...node.childNodes].map((part) => part.textContent ?? ""),
      clipped: node.scrollWidth > node.clientWidth + 1,
      cut: [...node.querySelectorAll("span")].some((one) => (one.textContent ?? "").length === 0),
      right: node.getBoundingClientRect().right,
      view: window.innerWidth,
    }));
    assert.equal(badge.parts.length, 3, `branch, added, removed: ${JSON.stringify(badge.parts)}`);
    assert.match(badge.parts[1], /^\+\d+$/);
    assert.match(badge.parts[2], /^−\d+$/);
    assert.ok(!badge.clipped && !badge.cut, `nothing is cut off: ${JSON.stringify(badge)}`);
    assert.ok(badge.right <= badge.view + 1, "and the badge stays inside the window");
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

test("the page threw nothing", { skip: blocked }, async () => {
  assert.deepEqual(crashes, []);
});
