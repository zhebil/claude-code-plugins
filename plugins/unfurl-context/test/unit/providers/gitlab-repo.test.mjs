import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gitlabRepoProvider } from "../../../hooks/providers/gitlab-repo.mjs";
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

const detect = (text) => gitlabRepoProvider.detect(text, findCodeRanges(text));

describe("gitlabRepoProvider.detect", () => {
  it("detects bare repo URLs", () => {
    const out = detect("see https://gitlab.com/group/proj");
    assert.equal(out.length, 1);
    assert.equal(out[0].fullPath, "group/proj");
    assert.equal(out[0].id, "gitlab-repo:group/proj");
  });

  it("detects subgroup project URLs", () => {
    const out = detect("https://gitlab.com/gitlab-org/security/gitlab and more");
    assert.equal(out.length, 1);
    assert.equal(out[0].fullPath, "gitlab-org/security/gitlab");
  });

  it("strips a trailing .git suffix", () => {
    const out = detect("clone https://gitlab.com/me/proj.git here");
    assert.equal(out.length, 1);
    assert.equal(out[0].fullPath, "me/proj");
  });

  it("skips sub-resource URLs (containing /-/)", () => {
    assert.deepEqual(detect("https://gitlab.com/me/proj/-/issues/1"), []);
    assert.deepEqual(detect("https://gitlab.com/me/proj/-/merge_requests/2"), []);
    assert.deepEqual(detect("https://gitlab.com/me/proj/-/blob/main/x.py"), []);
  });

  it("skips reserved top-level paths (users, explore, etc.)", () => {
    assert.deepEqual(detect("https://gitlab.com/users/zhebil"), []);
    assert.deepEqual(detect("https://gitlab.com/explore/projects"), []);
  });

  it("dedupes repeated mentions", () => {
    const out = detect(
      "first https://gitlab.com/me/proj second https://gitlab.com/me/proj",
    );
    assert.equal(out.length, 1);
  });

  it("skips repo URLs inside backticks", () => {
    assert.deepEqual(detect("`https://gitlab.com/me/proj`"), []);
  });

  it("skips repo URLs inside fenced blocks", () => {
    assert.deepEqual(detect("```\nhttps://gitlab.com/me/proj\n```"), []);
  });

  it("excludes a sentence-ending period from the project name", () => {
    const out = detect("clone https://gitlab.com/foo/bar.");
    assert.equal(out.length, 1);
    assert.equal(out[0].fullPath, "foo/bar");
  });

  it("excludes a trailing question mark", () => {
    const out = detect("which is it, https://gitlab.com/me/proj?");
    assert.equal(out.length, 1);
    assert.equal(out[0].fullPath, "me/proj");
  });
});

describe("gitlabRepoProvider.summarize", () => {
  it("formats short label", () => {
    assert.equal(
      gitlabRepoProvider.summarize({ fullPath: "g/p" }),
      "glab-repo g/p",
    );
  });
});

describe("gitlabRepoProvider.fetch", () => {
  const meta = {
    description: "demo",
    web_url: "https://gitlab.com/me/proj",
    default_branch: "main",
    visibility: "public",
    star_count: 5,
    license: { key: "mit" },
    readme_url: "https://gitlab.com/me/proj/-/blob/main/README.md",
  };

  it("formats meta + README", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(meta), stderr: "" },
      { code: 0, stdout: "# Title\n\nbody", stderr: "" },
    ]);
    const block = await gitlabRepoProvider.fetch(
      { fullPath: "me/proj" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### Project me/proj: demo"));
    assert.ok(block.includes("- Default branch: main"));
    assert.ok(block.includes("- Visibility: public"));
    assert.ok(block.includes("- Stars: 5"));
    assert.ok(block.includes("- License: mit"));
    assert.ok(block.includes("**README:**"));
    assert.ok(block.includes("# Title"));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ["api", "projects/me%2Fproj"]);
    assert.deepEqual(calls[1].args, [
      "api",
      "projects/me%2Fproj/repository/files/README.md/raw?ref=main",
    ]);
  });

  it("URL-encodes subgroup paths", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: "{}", stderr: "" },
    ]);
    await gitlabRepoProvider.fetch(
      { fullPath: "gitlab-org/security/gitlab" },
      { cwd: "/tmp", runner },
    );
    assert.deepEqual(calls[0].args, [
      "api",
      "projects/gitlab-org%2Fsecurity%2Fgitlab",
    ]);
  });

  it("returns null when meta fetch fails", async () => {
    const { runner } = makeQueueRunner([
      { code: 1, stdout: "", stderr: "" },
    ]);
    const out = await gitlabRepoProvider.fetch(
      { fullPath: "a/b" },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });

  it("renders meta without README when readme_url is missing", async () => {
    const { runner, calls } = makeQueueRunner([
      {
        code: 0,
        stdout: JSON.stringify({ default_branch: "main", web_url: "https://gitlab.com/a/b" }),
        stderr: "",
      },
    ]);
    const block = await gitlabRepoProvider.fetch(
      { fullPath: "a/b" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### Project a/b"));
    assert.ok(!block.includes("**README:**"));
    assert.equal(calls.length, 1);
  });

  it("truncates README beyond MAX_README_CHARS", async () => {
    const longReadme = "x".repeat(20000);
    const { runner } = makeQueueRunner([
      { code: 0, stdout: JSON.stringify(meta), stderr: "" },
      { code: 0, stdout: longReadme, stderr: "" },
    ]);
    const block = await gitlabRepoProvider.fetch(
      { fullPath: "me/proj" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("README truncated"));
    assert.ok(!block.includes("x".repeat(13000)));
  });
});
