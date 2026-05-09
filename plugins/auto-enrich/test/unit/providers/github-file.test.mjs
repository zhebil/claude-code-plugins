import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { githubFileProvider } from "../../../hooks/providers/github-file.mjs";
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

const detect = (text) => githubFileProvider.detect(text, findCodeRanges(text));

describe("githubFileProvider.detect", () => {
  it("detects a /blob/ URL with no anchor", () => {
    const out = detect("see https://github.com/me/proj/blob/main/src/foo.py");
    assert.equal(out.length, 1);
    assert.equal(out[0].owner, "me");
    assert.equal(out[0].repo, "proj");
    assert.equal(out[0].ref, "main");
    assert.equal(out[0].path, "src/foo.py");
    assert.equal(out[0].anchor, null);
    assert.equal(out[0].id, "github-file:me/proj@main/src/foo.py");
  });

  it("detects a single-line anchor #L10", () => {
    const out = detect("https://github.com/me/proj/blob/main/x.py#L10");
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].anchor, { start: 10, end: 10 });
    assert.equal(out[0].id, "github-file:me/proj@main/x.py#L10-L10");
  });

  it("detects a range anchor #L10-L20", () => {
    const out = detect("https://github.com/me/proj/blob/main/x.py#L10-L20");
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].anchor, { start: 10, end: 20 });
  });

  it("normalizes inverted ranges", () => {
    const out = detect("https://github.com/me/proj/blob/main/x.py#L20-L10");
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].anchor, { start: 10, end: 20 });
  });

  it("ignores malformed anchors", () => {
    const out = detect("https://github.com/me/proj/blob/main/x.py#section-foo");
    assert.equal(out.length, 1);
    assert.equal(out[0].anchor, null);
  });

  it("strips a query string from the path (e.g. ?plain=1)", () => {
    const out = detect("https://github.com/me/proj/blob/main/README.md?plain=1#L5");
    assert.equal(out.length, 1);
    assert.equal(out[0].path, "README.md");
    assert.deepEqual(out[0].anchor, { start: 5, end: 5 });
  });

  it("detects /raw/ URLs", () => {
    const out = detect("https://github.com/me/proj/raw/main/data.csv");
    assert.equal(out.length, 1);
    assert.equal(out[0].path, "data.csv");
    assert.equal(out[0].id, "github-file:me/proj@main/data.csv");
  });

  it("detects raw.githubusercontent.com URLs", () => {
    const out = detect("https://raw.githubusercontent.com/me/proj/abc123/lib/x.ts");
    assert.equal(out.length, 1);
    assert.equal(out[0].owner, "me");
    assert.equal(out[0].ref, "abc123");
    assert.equal(out[0].path, "lib/x.ts");
  });

  it("excludes a sentence-ending period from the path", () => {
    const out = detect("look at https://github.com/me/proj/blob/main/src/foo.py.");
    assert.equal(out.length, 1);
    assert.equal(out[0].path, "src/foo.py");
  });

  it("excludes a trailing comma in a list", () => {
    const out = detect(
      "see https://github.com/me/proj/blob/main/a.py, https://github.com/me/proj/blob/main/b.py",
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].path, "a.py");
    assert.equal(out[1].path, "b.py");
  });

  it("strips trailing closing parens (markdown link wrapper)", () => {
    const out = detect("(see https://github.com/me/proj/blob/main/x.py)");
    assert.equal(out.length, 1);
    assert.equal(out[0].path, "x.py");
  });

  it("skips file URLs inside backticks", () => {
    assert.deepEqual(
      detect("`https://github.com/me/proj/blob/main/x.py`"),
      [],
    );
  });

  it("skips file URLs inside fenced blocks", () => {
    assert.deepEqual(
      detect("```\nhttps://github.com/me/proj/blob/main/x.py\n```"),
      [],
    );
  });

  it("dedupes identical URLs", () => {
    const out = detect(
      "https://github.com/me/proj/blob/main/x.py and again https://github.com/me/proj/blob/main/x.py",
    );
    assert.equal(out.length, 1);
  });

  it("does NOT dedupe the same file at different anchors", () => {
    const out = detect(
      "https://github.com/me/proj/blob/main/x.py#L1-L5 https://github.com/me/proj/blob/main/x.py#L10-L20",
    );
    assert.equal(out.length, 2);
  });

  it("skips binary extensions before fetching", () => {
    assert.deepEqual(detect("https://github.com/me/proj/blob/main/logo.png"), []);
    assert.deepEqual(detect("https://github.com/me/proj/blob/main/dist.zip"), []);
    assert.deepEqual(detect("https://github.com/me/proj/blob/main/font.woff2"), []);
  });

  it("treats SVG as text (not in the binary blocklist)", () => {
    const out = detect("https://github.com/me/proj/blob/main/icon.svg");
    assert.equal(out.length, 1);
    assert.equal(out[0].path, "icon.svg");
  });

  it("treats the first segment after /blob/ as the ref (no multi-segment recovery)", () => {
    const out = detect("https://github.com/me/proj/blob/feature/foo/src/x.ts");
    assert.equal(out.length, 1);
    assert.equal(out[0].ref, "feature");
    assert.equal(out[0].path, "foo/src/x.ts");
  });

  it("handles GitHub permalink form /blob/refs/heads/<branch>/<path>", () => {
    const out = detect("https://github.com/me/proj/blob/refs/heads/main/src/x.py");
    assert.equal(out.length, 1);
    assert.equal(out[0].ref, "refs/heads/main");
    assert.equal(out[0].path, "src/x.py");
    assert.equal(out[0].id, "github-file:me/proj@refs/heads/main/src/x.py");
  });

  it("handles tag permalink form /blob/refs/tags/<tag>/<path>", () => {
    const out = detect("https://github.com/me/proj/blob/refs/tags/v1.2.3/CHANGELOG.md");
    assert.equal(out.length, 1);
    assert.equal(out[0].ref, "refs/tags/v1.2.3");
    assert.equal(out[0].path, "CHANGELOG.md");
  });

  it("handles refs/heads on the raw host too", () => {
    const out = detect("https://raw.githubusercontent.com/me/proj/refs/heads/main/x.ts");
    assert.equal(out.length, 1);
    assert.equal(out[0].ref, "refs/heads/main");
    assert.equal(out[0].path, "x.ts");
  });

  it("rejects an inverted-zero anchor (#L10-L0) instead of slicing line 0", () => {
    // After normalization start=0,end=10 - which we treat as invalid.
    const out = detect("https://github.com/me/proj/blob/main/x.py#L10-L0");
    assert.equal(out.length, 1);
    assert.equal(out[0].anchor, null);
  });
});

describe("githubFileProvider.summarize", () => {
  it("formats summary without anchor", () => {
    assert.equal(
      githubFileProvider.summarize({
        owner: "me", repo: "proj", ref: "main", path: "src/x.py", anchor: null,
      }),
      "file me/proj:src/x.py",
    );
  });

  it("formats summary with anchor", () => {
    assert.equal(
      githubFileProvider.summarize({
        owner: "me", repo: "proj", ref: "main", path: "src/x.py",
        anchor: { start: 10, end: 20 },
      }),
      "file me/proj:src/x.py#L10-L20",
    );
  });
});

describe("githubFileProvider.fetch", () => {
  const baseMatch = {
    owner: "me", repo: "proj", ref: "main", path: "src/x.py", anchor: null,
  };

  it("formats a whole-file block with metadata and a fenced code body", async () => {
    const content = "def hello():\n    return 1\n";
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await githubFileProvider.fetch(baseMatch, { cwd: "/tmp", runner });
    assert.ok(block.includes("#### File me/proj@main - src/x.py"));
    assert.ok(block.includes("- URL: https://github.com/me/proj/blob/main/src/x.py"));
    assert.ok(block.includes("- Ref: main"));
    assert.ok(block.includes("```python"));
    assert.ok(block.includes("def hello():"));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "api",
      "repos/me/proj/contents/src/x.py?ref=main",
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
  });

  it("slices to the anchored range and prefixes line numbers", async () => {
    const content = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await githubFileProvider.fetch(
      { ...baseMatch, anchor: { start: 10, end: 12 } },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("#### File me/proj@main - src/x.py - lines 10-12"));
    assert.ok(block.includes("10: line10"));
    assert.ok(block.includes("11: line11"));
    assert.ok(block.includes("12: line12"));
    assert.ok(!block.includes("13: line13"));
    assert.ok(!block.includes("9: line9"));
  });

  it("falls back to whole file with note when anchor is out of range", async () => {
    const content = "a\nb\nc\n";
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await githubFileProvider.fetch(
      { ...baseMatch, anchor: { start: 100, end: 200 } },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("out of range"));
    assert.ok(block.includes("```python"));
    assert.ok(block.includes("a\nb\nc"));
    assert.ok(!block.includes("100: "));
  });

  it("clamps an end-of-range that exceeds the file length", async () => {
    const content = "l1\nl2\nl3";
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await githubFileProvider.fetch(
      { ...baseMatch, anchor: { start: 2, end: 99 } },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("- lines 2-3"));
    assert.ok(block.includes("2: l2"));
    assert.ok(block.includes("3: l3"));
  });

  it("truncates whole-file content beyond MAX_FILE_CHARS with a hint", async () => {
    const content = "x".repeat(20000);
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await githubFileProvider.fetch(baseMatch, { cwd: "/tmp", runner });
    assert.ok(block.includes("content truncated"));
    assert.ok(block.includes("#L10-L20"));
  });

  it("uses a longer fence when the body contains backtick runs", async () => {
    const content = "```python\nprint('hi')\n```\n";
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await githubFileProvider.fetch(
      { ...baseMatch, path: "README.md" },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("````markdown"));
    assert.ok(block.includes("````\n\nRefetch:"));
  });

  it("emits no language tag for unknown extensions", async () => {
    const { runner } = makeQueueRunner([
      { code: 0, stdout: "anything", stderr: "" },
    ]);
    const block = await githubFileProvider.fetch(
      { ...baseMatch, path: "data.weird" },
      { cwd: "/tmp", runner },
    );
    assert.ok(/```\nanything\n```/.test(block));
  });

  it("returns null on gh failure (404)", async () => {
    const { runner } = makeQueueRunner([
      { code: 1, stdout: "", stderr: "Not Found" },
    ]);
    const out = await githubFileProvider.fetch(baseMatch, { cwd: "/tmp", runner });
    assert.equal(out, null);
  });

  it("returns null on empty content", async () => {
    const { runner } = makeQueueRunner([
      { code: 0, stdout: "", stderr: "" },
    ]);
    const out = await githubFileProvider.fetch(baseMatch, { cwd: "/tmp", runner });
    assert.equal(out, null);
  });

  it("URL-encodes ref and path segments in the gh api call", async () => {
    const { runner, calls } = makeQueueRunner([
      { code: 0, stdout: "anything", stderr: "" },
    ]);
    await githubFileProvider.fetch(
      { ...baseMatch, ref: "feat/with space", path: "dir with space/x.py" },
      { cwd: "/tmp", runner },
    );
    assert.equal(
      calls[0].args[1],
      "repos/me/proj/contents/dir%20with%20space/x.py?ref=feat/with%20space",
    );
  });

  it("does not phantom-count a single trailing newline as an extra line", async () => {
    const content = "a\nb\nc\n";
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await githubFileProvider.fetch(baseMatch, { cwd: "/tmp", runner });
    // 3 real lines plus the trailing-newline byte; should report 3 lines.
    assert.ok(/3 lines/.test(block));
  });

  it("treats #L<lastLine+1> as out of range when file ends with newline", async () => {
    const content = "a\nb\nc\n";
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await githubFileProvider.fetch(
      { ...baseMatch, anchor: { start: 4, end: 4 } },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("out of range"));
  });

  it("emits an anchor-aware truncation hint when an anchor is present", async () => {
    // 1500 short numbered lines well over 12000 chars after numbering.
    const content = Array.from({ length: 1500 }, (_, i) => `line${i + 1}`).join("\n");
    const { runner } = makeQueueRunner([
      { code: 0, stdout: content, stderr: "" },
    ]);
    const block = await githubFileProvider.fetch(
      { ...baseMatch, anchor: { start: 1, end: 1500 } },
      { cwd: "/tmp", runner },
    );
    assert.ok(block.includes("content truncated"));
    assert.ok(block.includes("smaller line range"));
    assert.ok(!block.includes("paste with #L10-L20"));
  });
});
