import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findCodeRanges, isInsideCode } from "../../../hooks/lib/code-ranges.mjs";

describe("findCodeRanges", () => {
  it("returns no ranges for plain text", () => {
    assert.deepEqual(findCodeRanges("plain text without code"), []);
  });

  it("captures inline backtick spans", () => {
    const text = "look at `foo` and `bar` here";
    const ranges = findCodeRanges(text);
    assert.equal(ranges.length, 2);
    assert.equal(text.slice(...ranges[0]), "`foo`");
    assert.equal(text.slice(...ranges[1]), "`bar`");
  });

  it("captures triple-backtick fenced blocks", () => {
    const text = "before\n```js\nconst x = 1\n```\nafter";
    const ranges = findCodeRanges(text);
    assert.equal(ranges.length, 1);
    assert.equal(text.slice(...ranges[0]), "```js\nconst x = 1\n```");
  });

  it("treats unclosed fence as running to end of text", () => {
    const text = "open ```js\nnever closed";
    const ranges = findCodeRanges(text);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0][1], text.length);
  });

  it("skips stray single backticks without a pair", () => {
    const text = "lone ` backtick FOO-1";
    const ranges = findCodeRanges(text);
    assert.deepEqual(ranges, []);
  });

  it("handles fenced blocks containing backticks", () => {
    const text = "```\nuse ` inside\n```";
    const ranges = findCodeRanges(text);
    assert.equal(ranges.length, 1);
    assert.equal(text.slice(...ranges[0]), text);
  });

  it("captures multiple separate ranges in order", () => {
    const text = "`a` then ```\nblock\n``` and `b`";
    const ranges = findCodeRanges(text);
    assert.equal(ranges.length, 3);
    assert.equal(text.slice(...ranges[0]), "`a`");
    assert.equal(text.slice(...ranges[1]), "```\nblock\n```");
    assert.equal(text.slice(...ranges[2]), "`b`");
  });
});

describe("isInsideCode", () => {
  const text = "outside `inside` outside `also` end";
  const ranges = findCodeRanges(text);

  it("returns true at the opening backtick", () => {
    assert.equal(isInsideCode(text.indexOf("`inside"), ranges), true);
  });

  it("returns true on a character inside the span", () => {
    assert.equal(isInsideCode(text.indexOf("inside"), ranges), true);
  });

  it("returns false outside any code span", () => {
    assert.equal(isInsideCode(0, ranges), false);
    assert.equal(isInsideCode(text.indexOf("end"), ranges), false);
  });

  it("returns false past the closing backtick", () => {
    const after = text.indexOf("`inside`") + "`inside`".length;
    assert.equal(isInsideCode(after, ranges), false);
  });

  it("returns false for empty range list", () => {
    assert.equal(isInsideCode(5, []), false);
  });
});
