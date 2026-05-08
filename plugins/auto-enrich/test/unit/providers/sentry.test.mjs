import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sentryProvider } from "../../../hooks/providers/sentry.mjs";
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

const detect = (text) => sentryProvider.detect(text, findCodeRanges(text));

describe("sentryProvider.detect", () => {
  it("detects sentry.io issue URLs", () => {
    const out = detect("error at https://sentry.io/issues/12345/");
    assert.equal(out.length, 1);
    assert.equal(out[0].issueId, "12345");
  });

  it("detects org-prefixed sentry URLs", () => {
    const out = detect("https://acme.sentry.io/issues/777/");
    assert.equal(out.length, 1);
    assert.equal(out[0].issueId, "777");
  });

  it("detects organizations-style URLs", () => {
    const out = detect("https://sentry.io/organizations/acme/issues/42");
    assert.equal(out.length, 1);
    assert.equal(out[0].issueId, "42");
  });

  it("dedupes repeated URLs", () => {
    const out = detect(
      "https://sentry.io/issues/1/ vs https://sentry.io/issues/1/",
    );
    assert.equal(out.length, 1);
  });

  it("skips URLs inside backticks", () => {
    assert.deepEqual(detect("`https://sentry.io/issues/1/`"), []);
  });

  it("skips URLs inside fenced blocks", () => {
    assert.deepEqual(detect("```\nhttps://sentry.io/issues/1/\n```"), []);
  });
});

describe("sentryProvider.summarize", () => {
  it("formats short label", () => {
    assert.equal(sentryProvider.summarize({ issueId: "9" }), "sentry 9");
  });
});

describe("sentryProvider.fetch", () => {
  const issue = {
    title: "Boom",
    permalink: "https://sentry.io/issues/9/",
    shortId: "PROJ-1",
    project: { slug: "proj" },
    level: "error",
    status: "unresolved",
    culprit: "AppRoot",
    count: 5,
    userCount: 3,
    firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-01-02T00:00:00Z",
    assignedTo: { name: "Alice" },
    metadata: { value: "msg" },
  };

  const event = {
    eventID: "deadbeef",
    tags: [
      { key: "environment", value: "prod" },
      { key: "browser", value: "Chrome" },
      { key: "ignored", value: "junk" },
    ],
    entries: [
      {
        type: "exception",
        data: {
          values: [
            {
              type: "TypeError",
              value: "x is not defined",
              stacktrace: {
                frames: [
                  { filename: "vendor.js", lineNo: 10, function: "lib", inApp: false },
                  { filename: "app.js", lineNo: 42, function: "go", inApp: true },
                ],
              },
            },
          ],
        },
      },
    ],
  };

  it("formats a Sentry issue with latest event details", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(issue), stderr: "" },
      { code: 0, stdout: JSON.stringify(event), stderr: "" },
    ]);
    const block = await sentryProvider.fetch(
      { issueId: "9" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### Sentry issue 9: Boom"));
    assert.ok(block.includes("- Project: proj"));
    assert.ok(block.includes("- Event count: 5"));
    assert.ok(block.includes("- Users affected: 3"));
    assert.ok(block.includes("- Assignee: Alice"));
    assert.ok(block.includes("**Tags:**"));
    assert.ok(block.includes("- environment: prod"));
    assert.ok(block.includes("- browser: Chrome"));
    assert.ok(!block.includes("ignored"));
    assert.ok(block.includes("**Exception:**"));
    assert.ok(block.includes("TypeError: x is not defined"));
    assert.ok(block.includes("at app.js:42 in go"));
    assert.ok(block.includes("at vendor.js:10 in lib [vendor]"));
    assert.ok(block.includes("Latest event ID: `deadbeef`"));
    assert.equal(calls.length, 2);
  });

  it("still formats issue when latest-event lookup fails", async () => {
    const { runner } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(issue), stderr: "" },
      { code: 1, stdout: "", stderr: "404" },
    ]);
    const block = await sentryProvider.fetch(
      { issueId: "9" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### Sentry issue 9: Boom"));
    assert.ok(!block.includes("**Tags:**"));
    assert.ok(!block.includes("**Exception:**"));
  });

  it("returns null when issue lookup fails", async () => {
    const { runner } = makeQueueRunner([
      { code: 1, stdout: "", stderr: "auth" },
    ]);
    const out = await sentryProvider.fetch(
      { issueId: "9" },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });

  it("falls back to event message when no exception entry", async () => {
    const noExc = {
      ...event,
      entries: [
        {
          type: "message",
          data: { formatted: "fallback message" },
        },
      ],
    };
    const { runner } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(issue), stderr: "" },
      { code: 0, stdout: JSON.stringify(noExc), stderr: "" },
    ]);
    const block = await sentryProvider.fetch(
      { issueId: "9" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("**Event message:**\nfallback message"));
  });
});
