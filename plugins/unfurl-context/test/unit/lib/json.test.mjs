import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeJsonParse } from "../../../hooks/lib/json.mjs";

describe("safeJsonParse", () => {
  it("parses valid JSON objects", () => {
    assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  });

  it("parses valid JSON arrays", () => {
    assert.deepEqual(safeJsonParse("[1,2,3]"), [1, 2, 3]);
  });

  it("parses primitives", () => {
    assert.equal(safeJsonParse("true"), true);
    assert.equal(safeJsonParse("42"), 42);
    assert.equal(safeJsonParse('"hi"'), "hi");
    assert.equal(safeJsonParse("null"), null);
  });

  it("returns null for invalid JSON", () => {
    assert.equal(safeJsonParse("not json"), null);
    assert.equal(safeJsonParse("{a: 1}"), null);
    assert.equal(safeJsonParse(""), null);
  });

  it("returns null for non-string inputs", () => {
    assert.equal(safeJsonParse(undefined), null);
    assert.equal(safeJsonParse(null), null);
  });
});
