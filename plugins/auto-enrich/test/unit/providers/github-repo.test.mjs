import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { githubRepoProvider } from "../../../hooks/providers/github-repo.mjs";
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

const detect = (text) => githubRepoProvider.detect(text, findCodeRanges(text));

describe("githubRepoProvider.detect", () => {
  it("detects bare repo URLs", () => {
    const out = detect("see https://github.com/anthropics/claude-code");
    assert.equal(out.length, 1);
    assert.equal(out[0].owner, "anthropics");
    assert.equal(out[0].repo, "claude-code");
  });

  it("strips a trailing .git suffix", () => {
    const out = detect("clone https://github.com/me/proj.git here");
    assert.equal(out.length, 1);
    assert.equal(out[0].repo, "proj");
  });

  it("skips reserved sub-paths (issues, pull, etc.)", () => {
    assert.deepEqual(detect("https://github.com/me/proj/issues/1"), []);
    assert.deepEqual(detect("https://github.com/me/proj/pull/2"), []);
    assert.deepEqual(detect("https://github.com/me/proj/actions"), []);
  });

  it("dedupes repeated mentions", () => {
    const out = detect(
      "first https://github.com/me/proj second https://github.com/me/proj",
    );
    assert.equal(out.length, 1);
  });

  it("skips repo URLs inside backticks", () => {
    assert.deepEqual(detect("`https://github.com/me/proj`"), []);
  });

  it("skips repo URLs inside fenced blocks", () => {
    assert.deepEqual(detect("```\nhttps://github.com/me/proj\n```"), []);
  });

  it("excludes a sentence-ending period from the repo name", () => {
    const out = detect("clone https://github.com/foo/bar.");
    assert.equal(out.length, 1);
    assert.equal(out[0].repo, "bar");
  });

  it("preserves dotted repo names like vue.js", () => {
    const out = detect("see https://github.com/vuejs/vue.js for details");
    assert.equal(out.length, 1);
    assert.equal(out[0].repo, "vue.js");
  });

  it("excludes trailing period after a dotted repo name", () => {
    const out = detect("look at https://github.com/vuejs/vue.js.");
    assert.equal(out.length, 1);
    assert.equal(out[0].repo, "vue.js");
  });

  it("excludes a trailing question mark", () => {
    const out = detect("which is it, https://github.com/me/proj?");
    assert.equal(out.length, 1);
    assert.equal(out[0].repo, "proj");
  });

  it("excludes a trailing exclamation", () => {
    const out = detect("look at https://github.com/me/proj!");
    assert.equal(out.length, 1);
    assert.equal(out[0].repo, "proj");
  });
});

describe("githubRepoProvider.summarize", () => {
  it("formats short label", () => {
    assert.equal(
      githubRepoProvider.summarize({ owner: "me", repo: "proj" }),
      "repo me/proj",
    );
  });
});

describe("githubRepoProvider.fetch", () => {
  const meta = {
    description: "demo",
    html_url: "https://github.com/me/proj",
    language: "JavaScript",
    default_branch: "main",
    stargazers_count: 7,
    license: { spdx_id: "MIT" },
  };

  it("formats meta + README", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(meta), stderr: "" },
      { code: 0, stdout: "# Title\n\nbody", stderr: "" },
    ]);
    const block = await githubRepoProvider.fetch(
      { owner: "me", repo: "proj" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### Repo me/proj: demo"));
    assert.ok(block.includes("- Language: JavaScript"));
    assert.ok(block.includes("- Stars: 7"));
    assert.ok(block.includes("- License: MIT"));
    assert.ok(block.includes("**README:**"));
    assert.ok(block.includes("# Title"));
    assert.equal(calls.length, 2);
  });

  it("truncates README beyond MAX_README_CHARS", async () => {
    const longReadme = "x".repeat(20000);
    const { runner } = makeQueueRunner([
      { code: 0, stdout: "{}", stderr: "" },
      { code: 0, stdout: longReadme, stderr: "" },
    ]);
    const block = await githubRepoProvider.fetch(
      { owner: "a", repo: "b" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("README truncated"));
    assert.ok(!block.includes("x".repeat(13000)));
  });

  it("returns null when both meta and README fail", async () => {
    const { runner } = makeQueueRunner([
      { code: 1, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "" },
    ]);
    const out = await githubRepoProvider.fetch(
      { owner: "a", repo: "b" },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });

  it("hides NOASSERTION license", async () => {
    const { runner } = makeQueueRunner([
      {
        code: 0,
        stdout: JSON.stringify({ license: { spdx_id: "NOASSERTION" } }),
        stderr: "",
      },
      { code: 0, stdout: "readme", stderr: "" },
    ]);
    const block = await githubRepoProvider.fetch(
      { owner: "a", repo: "b" },
      { cwd: "/tmp", runner },
    );
    assert.ok(!block.includes("- License:"));
  });
});
