import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_TRUNCATION_NOTE,
  MIN_PARTIAL_BLOCK_CHARS,
  fitBlock,
} from "../../../hooks/lib/context-budget.mjs";

describe("fitBlock", () => {
  it("returns a block that fits unchanged", () => {
    assert.deepEqual(fitBlock("short", 100), { text: "short", truncated: false });
  });

  it("cuts an oversized block at a line boundary and stays within room", () => {
    const block = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const fitted = fitBlock(block, 1000);
    assert.equal(fitted.truncated, true);
    assert.ok(fitted.text.length <= 1000);
    assert.ok(fitted.text.endsWith(`\n${BLOCK_TRUNCATION_NOTE}`));
    assert.match(fitted.text, /line \d+\n\.\.\.\(block truncated/);
  });

  it("hard-cuts a block whose only line break is far before the limit", () => {
    const block = `header\n${"x".repeat(5000)}`;
    const fitted = fitBlock(block, 1000);
    assert.equal(fitted.truncated, true);
    assert.equal(fitted.text.length, 1000);
    assert.match(fitted.text, /^header\nx+/);
  });

  it("drops a block when there is too little room for a useful partial", () => {
    assert.equal(fitBlock("x".repeat(1000), MIN_PARTIAL_BLOCK_CHARS - 1), null);
  });
});
