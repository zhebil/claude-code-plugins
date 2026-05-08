import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jiraProvider } from "../../../hooks/providers/jira.mjs";
import { findCodeRanges } from "../../../hooks/lib/code-ranges.mjs";

function makeQueueRunner(queue) {
  const calls = [];
  return {
    calls,
    runner: async (command, args) => {
      calls.push({ command, args });
      if (!queue.length) return { code: 127, stdout: "", stderr: "queue empty" };
      return queue.shift();
    },
  };
}

const detect = (text) => jiraProvider.detect(text, findCodeRanges(text));

describe("jiraProvider.detect", () => {
  it("detects bare keys", () => {
    const out = detect("blocked by SA-123");
    assert.equal(out.length, 1);
    assert.equal(out[0].key, "SA-123");
  });

  it("detects atlassian.net browse URLs", () => {
    const out = detect("https://acme.atlassian.net/browse/PROJ-9");
    assert.equal(out.length, 1);
    assert.equal(out[0].key, "PROJ-9");
  });

  it("dedupes URL and key referring to the same issue", () => {
    const out = detect("see https://acme.atlassian.net/browse/PROJ-9 (PROJ-9)");
    assert.equal(out.length, 1);
  });

  it("supports project codes with digits", () => {
    const out = detect("ticket SA2-3356");
    assert.equal(out.length, 1);
    assert.equal(out[0].key, "SA2-3356");
  });

  it("rejects lowercase project codes", () => {
    assert.deepEqual(detect("foo-123"), []);
  });

  it("skips keys inside backticks", () => {
    assert.deepEqual(detect("not real `SA-1`"), []);
  });

  it("skips keys inside fenced blocks", () => {
    assert.deepEqual(detect("```\nSA-1\n```"), []);
  });

  it("skips URLs inside backticks", () => {
    assert.deepEqual(detect("`https://acme.atlassian.net/browse/SA-1`"), []);
  });

  it("does not match keys glued to surrounding word characters", () => {
    assert.deepEqual(detect("xSA-1"), []);
    assert.deepEqual(detect("SA-1y"), []);
  });
});

describe("jiraProvider.summarize", () => {
  it("formats short label", () => {
    assert.equal(jiraProvider.summarize({ key: "SA-1" }), "jira SA-1");
  });
});

describe("jiraProvider.fetch (acli backend - default)", () => {
  const issue = {
    url: "https://acme.atlassian.net/browse/SA-1",
    fields: {
      summary: "Title",
      issuetype: { name: "Task" },
      status: { name: "In Progress" },
      priority: { name: "High" },
      assignee: { displayName: "Alice" },
      reporter: { displayName: "Bob" },
      description: "plain description",
    },
  };

  it("formats a Jira issue from acli output", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(issue), stderr: "" },
    ]);
    const block = await jiraProvider.fetch(
      { key: "SA-1" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### Jira SA-1: Title"));
    assert.ok(block.includes("- Type: Task"));
    assert.ok(block.includes("- Status: In Progress"));
    assert.ok(block.includes("- Priority: High"));
    assert.ok(block.includes("- Assignee: Alice"));
    assert.ok(block.includes("- Reporter: Bob"));
    assert.ok(block.includes("**Description:**\nplain description"));
    assert.ok(block.includes("acli jira workitem view SA-1 --comments"));
    assert.equal(calls[0].command, "acli");
    assert.deepEqual(calls[0].args, ["jira", "workitem", "view", "SA-1", "--json"]);
  });

  it("falls back to 'unassigned' when assignee missing", async () => {
    const { runner } = makeQueueRunner([
      {
        code: 0,
        stdout: JSON.stringify({ fields: { summary: "x" } }),
        stderr: "",
      },
    ]);
    const block = await jiraProvider.fetch(
      { key: "SA-1" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("- Assignee: unassigned"));
  });

  it("returns null when acli fails", async () => {
    const { runner } = makeQueueRunner([
      { code: 1, stdout: "", stderr: "auth required" },
    ]);
    const out = await jiraProvider.fetch(
      { key: "SA-1" },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });

  it("returns null on invalid JSON output", async () => {
    const { runner } = makeQueueRunner([
      { code: 0, stdout: "not json", stderr: "" },
    ]);
    const out = await jiraProvider.fetch(
      { key: "SA-1" },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });
});

describe("jiraProvider.fetch (jira-cli backend)", () => {
  const jiraCliIssue = {
    key: "SA-1",
    fields: {
      summary: "Title",
      issueType: { name: "Bug" },
      status: { name: "Open" },
      priority: { name: "Medium" },
      assignee: { displayName: "Alice" },
      reporter: { displayName: "Bob" },
      description: "raw description",
    },
  };

  const ctxWithBackend = (backend, runner) => ({
    cwd: "/tmp",
    runner,
    providerConfig: (name) => (name === "jira" ? { cli: backend } : {}),
  });

  it("invokes `jira issue list --jql key = X --raw` and unwraps the array", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify([jiraCliIssue]), stderr: "" },
    ]);
    const block = await jiraProvider.fetch(
      { key: "SA-1" },
      ctxWithBackend("jira-cli", runner),
    );
    assert.ok(block.includes("#### Jira SA-1: Title"));
    assert.ok(block.includes("- Type: Bug"), `expected camelCase issueType to map to Type, got:\n${block}`);
    assert.ok(block.includes("- Status: Open"));
    assert.ok(block.includes("- Priority: Medium"));
    assert.ok(block.includes("- Assignee: Alice"));
    assert.ok(block.includes("**Description:**\nraw description"));
    assert.ok(block.includes("jira issue view SA-1 --comments 10"));
    assert.equal(calls[0].command, "jira");
    assert.deepEqual(calls[0].args, [
      "issue", "list", "--jql", "key = SA-1", "--raw", "--paginate", "0:1",
    ]);
  });

  it("returns null when jira-cli returns an empty array", async () => {
    const { runner } = makeQueueRunner([
      { code: 0, stdout: "[]", stderr: "" },
    ]);
    const out = await jiraProvider.fetch(
      { key: "SA-1" },
      ctxWithBackend("jira-cli", runner),
    );
    assert.equal(out, null);
  });

  it("returns null when jira-cli fails", async () => {
    const { runner } = makeQueueRunner([
      { code: 1, stdout: "", stderr: "config missing" },
    ]);
    const out = await jiraProvider.fetch(
      { key: "SA-1" },
      ctxWithBackend("jira-cli", runner),
    );
    assert.equal(out, null);
  });

  it("falls back to acli for an unknown cli value", async () => {
    const { runner, calls } = makeQueueRunner([
      {
        code: 0,
        stdout: JSON.stringify({ fields: { summary: "x" } }),
        stderr: "",
      },
    ]);
    const block = await jiraProvider.fetch(
      { key: "SA-1" },
      ctxWithBackend("not-a-real-cli", runner),
    );
    assert.ok(block);
    assert.equal(calls[0].command, "acli");
  });
});
