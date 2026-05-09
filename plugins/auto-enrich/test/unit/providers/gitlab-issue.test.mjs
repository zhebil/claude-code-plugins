import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gitlabIssueProvider } from "../../../hooks/providers/gitlab-issue.mjs";
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

const detect = (text) => gitlabIssueProvider.detect(text, findCodeRanges(text));

describe("gitlabIssueProvider.detect", () => {
  it("detects issue URLs", () => {
    const out = detect("see https://gitlab.com/group/proj/-/issues/12");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "gitlab:group/proj#12");
    assert.equal(out[0].fullPath, "group/proj");
    assert.equal(out[0].iid, "12");
    assert.equal(out[0].isMr, false);
  });

  it("detects merge request URLs with the !N sigil id", () => {
    const out = detect("review https://gitlab.com/group/proj/-/merge_requests/9");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "gitlab:group/proj!9");
    assert.equal(out[0].isMr, true);
  });

  it("supports subgroups in the project path", () => {
    const out = detect(
      "https://gitlab.com/gitlab-org/security/gitlab/-/issues/100",
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].fullPath, "gitlab-org/security/gitlab");
    assert.equal(out[0].iid, "100");
  });

  it("dedupes repeats", () => {
    const text =
      "https://gitlab.com/g/p/-/issues/1 again https://gitlab.com/g/p/-/issues/1";
    const out = detect(text);
    assert.equal(out.length, 1);
  });

  it("skips URLs inside backticks", () => {
    assert.deepEqual(detect("`https://gitlab.com/g/p/-/issues/1`"), []);
  });

  it("skips URLs inside fenced blocks", () => {
    const text = "```\nhttps://gitlab.com/g/p/-/merge_requests/2\n```";
    assert.deepEqual(detect(text), []);
  });

  it("does not match a plain repo URL (no /-/)", () => {
    assert.deepEqual(detect("https://gitlab.com/group/proj"), []);
  });
});

describe("gitlabIssueProvider.summarize", () => {
  it("uses # for issues", () => {
    assert.equal(
      gitlabIssueProvider.summarize({ fullPath: "g/p", iid: "3", isMr: false }),
      "glab g/p#3",
    );
  });

  it("uses ! for merge requests", () => {
    assert.equal(
      gitlabIssueProvider.summarize({ fullPath: "g/p", iid: "9", isMr: true }),
      "glab g/p!9",
    );
  });
});

describe("gitlabIssueProvider.fetch", () => {
  const issuePayload = {
    title: "Bug",
    state: "opened",
    web_url: "https://gitlab.com/group/proj/-/issues/3",
    author: { username: "alice" },
    labels: ["bug", "P1"],
    description: "issue body",
  };

  it("formats an issue when glab api succeeds", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(issuePayload), stderr: "" },
    ]);
    const block = await gitlabIssueProvider.fetch(
      { id: "gitlab:group/proj#3", fullPath: "group/proj", iid: "3", isMr: false },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### Issue group/proj#3: Bug"));
    assert.ok(block.includes("- State: opened"));
    assert.ok(block.includes("- Author: alice"));
    assert.ok(block.includes("- Labels: bug, P1"));
    assert.ok(block.includes("issue body"));
    assert.ok(block.includes("glab issue view 3 -R group/proj --comments"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "glab");
    assert.deepEqual(calls[0].args, ["api", "projects/group%2Fproj/issues/3"]);
  });

  it("URL-encodes subgroup paths in the API call", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(issuePayload), stderr: "" },
    ]);
    await gitlabIssueProvider.fetch(
      { fullPath: "gitlab-org/security/gitlab", iid: "100", isMr: false },
      { cwd: "/tmp", runner },
    );
    assert.deepEqual(calls[0].args, [
      "api",
      "projects/gitlab-org%2Fsecurity%2Fgitlab/issues/100",
    ]);
  });

  it("formats an MR with branch and merge status", async () => {
    const mrPayload = {
      title: "Add feature",
      state: "opened",
      web_url: "https://gitlab.com/g/p/-/merge_requests/9",
      author: { username: "alice" },
      source_branch: "feat/x",
      target_branch: "main",
      draft: false,
      merge_status: "can_be_merged",
      detailed_merge_status: "mergeable",
      description: "PR body",
    };
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(mrPayload), stderr: "" },
    ]);
    const block = await gitlabIssueProvider.fetch(
      { fullPath: "g/p", iid: "9", isMr: true },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### MR g/p!9: Add feature"));
    assert.ok(block.includes("- Branch: feat/x -> main"));
    assert.ok(block.includes("- Merge status: can_be_merged"));
    assert.ok(block.includes("- Detailed status: mergeable"));
    assert.ok(block.includes("PR body"));
    assert.ok(block.includes("glab mr view 9 -R g/p --comments"));
    assert.deepEqual(calls[0].args, ["api", "projects/g%2Fp/merge_requests/9"]);
  });

  it("marks draft MRs", async () => {
    const { runner } = makeQueueRunner([
      {
        code: 0,
        stdout: JSON.stringify({ title: "x", state: "opened", draft: true }),
        stderr: "",
      },
    ]);
    const block = await gitlabIssueProvider.fetch(
      { fullPath: "g/p", iid: "1", isMr: true },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("- Draft: yes"));
  });

  it("returns null when glab api fails", async () => {
    const { runner } = makeQueueRunner([
      { code: 1, stdout: "", stderr: "boom" },
    ]);
    const out = await gitlabIssueProvider.fetch(
      { fullPath: "g/p", iid: "3", isMr: false },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });

  it("returns null when glab returns invalid JSON", async () => {
    const { runner } = makeQueueRunner([
      { code: 0, stdout: "<html>", stderr: "" },
    ]);
    const out = await gitlabIssueProvider.fetch(
      { fullPath: "g/p", iid: "3", isMr: false },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });
});
