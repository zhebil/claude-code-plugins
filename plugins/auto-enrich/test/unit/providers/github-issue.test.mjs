import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { githubIssueProvider } from "../../../hooks/providers/github-issue.mjs";
import { findCodeRanges } from "../../../hooks/lib/code-ranges.mjs";

function makeQueueRunner(queue) {
  const calls = [];
  return {
    calls,
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      if (!queue.length) return { code: 127, stdout: "", stderr: "queue empty" };
      return queue.shift();
    },
  };
}

function ctxWithDefaultRepo(defaultRepo) {
  return { state: defaultRepo ? { "github-issue": { defaultRepo } } : {} };
}

const detect = (text, ctx = { state: {} }) =>
  githubIssueProvider.detect(text, findCodeRanges(text), ctx);

describe("githubIssueProvider.detect", () => {
  it("detects full GitHub issue URLs", () => {
    const out = detect("see https://github.com/anthropics/claude-code/issues/12");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "github:anthropics/claude-code#12");
  });

  it("detects full GitHub PR URLs", () => {
    const out = detect("review https://github.com/owner/repo/pull/9");
    assert.equal(out.length, 1);
    assert.equal(out[0].number, "9");
  });

  it("detects short refs like owner/repo#123", () => {
    const out = detect("blocked by anthropics/claude-code#42");
    assert.equal(out.length, 1);
    assert.equal(out[0].owner, "anthropics");
    assert.equal(out[0].repo, "claude-code");
    assert.equal(out[0].number, "42");
  });

  it("resolves bare #N refs against state.defaultRepo", () => {
    const out = detect("close #15", ctxWithDefaultRepo("me/proj"));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "github:me/proj#15");
  });

  it("ignores bare #N when no defaultRepo is supplied", () => {
    assert.deepEqual(detect("close #15"), []);
  });

  it("dedupes when the same ref appears in multiple shapes", () => {
    const text =
      "https://github.com/me/proj/issues/3 vs me/proj#3 vs #3";
    const out = detect(text, ctxWithDefaultRepo("me/proj"));
    assert.equal(out.length, 1);
  });

  it("skips refs inside inline backticks", () => {
    const out = detect("not real `me/proj#7`");
    assert.deepEqual(out, []);
  });

  it("skips refs inside fenced code blocks", () => {
    const text = "```\nme/proj#7\n```";
    assert.deepEqual(detect(text), []);
  });

  it("skips full URLs inside backticks", () => {
    const out = detect("`https://github.com/me/proj/issues/1`");
    assert.deepEqual(out, []);
  });
});

describe("githubIssueProvider.prepare", () => {
  it("does nothing when prompt has no bare #N ref", async () => {
    const { runner, calls } = makeQueueRunner([]);
    const ctx = { cwd: "/tmp", runner, state: {} };
    await githubIssueProvider.prepare("plain text owner/repo#1", ctx);
    assert.equal(calls.length, 0);
    assert.deepEqual(ctx.state, {});
  });

  it("populates state when gh repo view succeeds", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: "me/proj\n", stderr: "" },
    ]);
    const ctx = { cwd: "/tmp", runner, state: {} };
    await githubIssueProvider.prepare("close #5", ctx);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "gh");
    assert.deepEqual(ctx.state["github-issue"], { defaultRepo: "me/proj" });
  });

  it("leaves state empty when gh repo view fails", async () => {
    const { runner } = makeQueueRunner([
      { code: 1, stdout: "", stderr: "not a repo" },
    ]);
    const ctx = { cwd: "/tmp", runner, state: {} };
    await githubIssueProvider.prepare("close #5", ctx);
    assert.deepEqual(ctx.state, {});
  });

  it("leaves state empty when gh returns blank stdout", async () => {
    const { runner } = makeQueueRunner([
      { code: 0, stdout: "   \n", stderr: "" },
    ]);
    const ctx = { cwd: "/tmp", runner, state: {} };
    await githubIssueProvider.prepare("close #5", ctx);
    assert.deepEqual(ctx.state, {});
  });
});

describe("githubIssueProvider.summarize", () => {
  it("formats a short label", () => {
    assert.equal(
      githubIssueProvider.summarize({ owner: "a", repo: "b", number: "9" }),
      "gh a/b#9",
    );
  });
});

describe("githubIssueProvider.fetch", () => {
  const issuePayload = {
    title: "Hello",
    state: "open",
    user: { login: "alice" },
    html_url: "https://github.com/me/proj/issues/3",
    body: "issue body",
    labels: [{ name: "bug" }, { name: "P1" }],
  };

  it("formats an issue when gh api succeeds", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(issuePayload), stderr: "" },
    ]);
    const block = await githubIssueProvider.fetch(
      { id: "github:me/proj#3", owner: "me", repo: "proj", number: "3" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### Issue me/proj#3: Hello"));
    assert.ok(block.includes("- State: open"));
    assert.ok(block.includes("- Author: alice"));
    assert.ok(block.includes("- Labels: bug, P1"));
    assert.ok(block.includes("issue body"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "gh");
  });

  it("returns null when gh api fails", async () => {
    const { runner } = makeQueueRunner([
      { code: 1, stdout: "", stderr: "boom" },
    ]);
    const out = await githubIssueProvider.fetch(
      { owner: "me", repo: "proj", number: "3" },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });

  it("returns null when gh stdout is not valid JSON", async () => {
    const { runner } = makeQueueRunner([
      { code: 0, stdout: "<html>", stderr: "" },
    ]);
    const out = await githubIssueProvider.fetch(
      { owner: "me", repo: "proj", number: "3" },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });

  it("formats a PR with a follow-up gh pr view call", async () => {
    const prIssue = {
      ...issuePayload,
      pull_request: {},
    };
    const prDetails = {
      title: "Hello",
      headRefName: "feat/x",
      baseRefName: "main",
      body: "PR body",
      reviewDecision: "APPROVED",
      isDraft: false,
      mergeable: "MERGEABLE",
      statusCheckRollup: [
        { conclusion: "SUCCESS" },
        { conclusion: "FAILURE" },
      ],
    };
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(prIssue), stderr: "" },
      { code: 0, stdout: JSON.stringify(prDetails), stderr: "" },
    ]);
    const block = await githubIssueProvider.fetch(
      { owner: "me", repo: "proj", number: "9" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### PR me/proj#9"));
    assert.ok(block.includes("- Branch: feat/x -> main"));
    assert.ok(block.includes("- Review: APPROVED"));
    assert.ok(block.includes("- Mergeable: MERGEABLE"));
    assert.ok(block.includes("- Checks: 2 total, 1 failing/pending"));
    assert.ok(block.includes("PR body"));
    assert.equal(calls[1].args[0], "pr");
    assert.equal(calls[1].args[1], "view");
  });
});
