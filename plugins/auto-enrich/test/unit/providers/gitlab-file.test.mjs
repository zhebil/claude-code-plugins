import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gitlabFileProvider } from "../../../hooks/providers/gitlab-file.mjs";
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

const detect = (text) => gitlabFileProvider.detect(text, findCodeRanges(text));

describe("gitlabFileProvider.detect", () => {
  it("detects a /-/blob/ URL with no anchor", () => {
    const out = detect("see https://gitlab.com/group/proj/-/blob/main/src/foo.py");
    assert.equal(out.length, 1);
    assert.equal(out[0].fullPath, "group/proj");
    assert.equal(out[0].ref, "main");
    assert.equal(out[0].path, "src/foo.py");
    assert.equal(out[0].anchor, null);
    assert.equal(out[0].id, "gitlab-file:group/proj@main/src/foo.py");
  });

  it("detects a /-/raw/ URL", () => {
    const out = detect("https://gitlab.com/group/proj/-/raw/main/data.csv");
    assert.equal(out.length, 1);
    assert.equal(out[0].path, "data.csv");
  });

  it("supports subgroups in the project path", () => {
    const out = detect(
      "https://gitlab.com/gitlab-org/security/gitlab/-/blob/master/README.md",
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].fullPath, "gitlab-org/security/gitlab");
    assert.equal(out[0].path, "README.md");
  });

  it("parses GitLab's native #L10-20 anchor", () => {
    const out = detect("https://gitlab.com/g/p/-/blob/main/x.py#L10-20");
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].anchor, { start: 10, end: 20 });
  });

  it("also accepts the GitHub-style #L10-L20 anchor", () => {
    const out = detect("https://gitlab.com/g/p/-/blob/main/x.py#L10-L20");
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].anchor, { start: 10, end: 20 });
  });

  it("parses a single-line anchor #L10", () => {
    const out = detect("https://gitlab.com/g/p/-/blob/main/x.py#L10");
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].anchor, { start: 10, end: 10 });
  });

  it("normalizes inverted ranges", () => {
    const out = detect("https://gitlab.com/g/p/-/blob/main/x.py#L20-10");
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].anchor, { start: 10, end: 20 });
  });

  it("ignores malformed anchors", () => {
    const out = detect("https://gitlab.com/g/p/-/blob/main/x.py#section-foo");
    assert.equal(out.length, 1);
    assert.equal(out[0].anchor, null);
  });

  it("strips a query string from the path", () => {
    const out = detect("https://gitlab.com/g/p/-/blob/main/README.md?ref_type=heads#L5");
    assert.equal(out.length, 1);
    assert.equal(out[0].path, "README.md");
    assert.deepEqual(out[0].anchor, { start: 5, end: 5 });
  });

  it("excludes a sentence-ending period from the path", () => {
    const out = detect("look at https://gitlab.com/g/p/-/blob/main/src/foo.py.");
    assert.equal(out.length, 1);
    assert.equal(out[0].path, "src/foo.py");
  });

  it("skips known binary extensions before fetching", () => {
    assert.deepEqual(
      detect("https://gitlab.com/g/p/-/blob/main/logo.png"),
      [],
    );
    assert.deepEqual(
      detect("https://gitlab.com/g/p/-/blob/main/dist/app.zip"),
      [],
    );
  });

  it("skips URLs inside backticks", () => {
    assert.deepEqual(
      detect("`https://gitlab.com/g/p/-/blob/main/x.py`"),
      [],
    );
  });

  it("skips URLs inside fenced blocks", () => {
    assert.deepEqual(
      detect("```\nhttps://gitlab.com/g/p/-/blob/main/x.py\n```"),
      [],
    );
  });

  it("dedupes repeated mentions", () => {
    const text =
      "https://gitlab.com/g/p/-/blob/main/x.py and again https://gitlab.com/g/p/-/blob/main/x.py";
    const out = detect(text);
    assert.equal(out.length, 1);
  });
});

describe("gitlabFileProvider.summarize", () => {
  it("formats a label without an anchor", () => {
    assert.equal(
      gitlabFileProvider.summarize({
        fullPath: "g/p", path: "src/x.py", anchor: null,
      }),
      "glab-file g/p:src/x.py",
    );
  });

  it("formats a label with an anchor", () => {
    assert.equal(
      gitlabFileProvider.summarize({
        fullPath: "g/p", path: "src/x.py", anchor: { start: 10, end: 20 },
      }),
      "glab-file g/p:src/x.py#L10-L20",
    );
  });
});

describe("gitlabFileProvider.fetch", () => {
  it("renders the full file when no anchor was supplied", async () => {
    const content = "def hello():\n    return 1\n\ndef bye():\n    return 2\n";
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await gitlabFileProvider.fetch(
      { fullPath: "g/p", ref: "main", path: "x.py", anchor: null },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### File g/p@main - x.py"));
    assert.ok(block.includes("```python"));
    assert.ok(block.includes("def hello():"));
    assert.ok(block.includes("def bye():"));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "api",
      "projects/g%2Fp/repository/files/x.py/raw?ref=main",
    ]);
  });

  it("URL-encodes file path and ref in the API call", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: "x", stderr: "" },
    ]);
    await gitlabFileProvider.fetch(
      {
        fullPath: "gitlab-org/security/gitlab",
        ref: "main",
        path: "src/sub dir/file.py",
        anchor: null,
      },
      { cwd: "/tmp", runner },
    );
    assert.deepEqual(calls[0].args, [
      "api",
      "projects/gitlab-org%2Fsecurity%2Fgitlab/repository/files/src%2Fsub%20dir%2Ffile.py/raw?ref=main",
    ]);
  });

  it("renders only the anchored slice when a range is supplied", async () => {
    const content = "line1\nline2\nline3\nline4\nline5\n";
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await gitlabFileProvider.fetch(
      { fullPath: "g/p", ref: "main", path: "x.py", anchor: { start: 2, end: 3 } },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("- lines 2-3"));
    assert.ok(block.includes("2: line2"));
    assert.ok(block.includes("3: line3"));
    assert.ok(!block.includes("line4"));
  });

  it("uses GitLab's native #L10-20 form in the rendered URL", async () => {
    const content = "a\nb\nc\nd\ne\n";
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await gitlabFileProvider.fetch(
      { fullPath: "g/p", ref: "main", path: "x.py", anchor: { start: 2, end: 4 } },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("https://gitlab.com/g/p/-/blob/main/x.py#L2-4"));
  });

  it("notes when an anchor is out of range and falls back to the full file", async () => {
    const content = "a\nb\n";
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await gitlabFileProvider.fetch(
      { fullPath: "g/p", ref: "main", path: "x.py", anchor: { start: 99, end: 100 } },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("out of range"));
    assert.ok(block.includes("a"));
    assert.ok(block.includes("b"));
  });

  it("returns null when glab fails", async () => {
    const { runner } = makeQueueRunner([
      { code: 1, stdout: "", stderr: "404" },
    ]);
    const out = await gitlabFileProvider.fetch(
      { fullPath: "g/p", ref: "main", path: "x.py", anchor: null },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });

  it("returns null on an empty file", async () => {
    const { runner } = makeQueueRunner([
      { code: 0, stdout: "", stderr: "" },
    ]);
    const out = await gitlabFileProvider.fetch(
      { fullPath: "g/p", ref: "main", path: "x.py", anchor: null },
      { cwd: "/tmp", runner },
    );
    assert.equal(out, null);
  });
});
