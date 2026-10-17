import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asText, pickFirstString } from "../../../hooks/lib/text.mjs";

describe("pickFirstString", () => {
  it("returns the first non-empty string", () => {
    assert.equal(pickFirstString("", "second", "third"), "second");
  });

  it("ignores nullish values", () => {
    assert.equal(pickFirstString(null, undefined, "x"), "x");
  });

  it("unwraps Jira-style display objects (displayName preferred)", () => {
    assert.equal(
      pickFirstString({ name: "name-val", displayName: "display-val" }),
      "display-val",
    );
  });

  it("falls back to name when displayName is missing", () => {
    assert.equal(pickFirstString({ name: "name-val" }), "name-val");
  });

  it("falls back to name when displayName is an empty string", () => {
    assert.equal(
      pickFirstString({ displayName: "", name: "real" }),
      "real",
    );
  });

  it("skips an object with all-empty fields and tries the next value", () => {
    assert.equal(
      pickFirstString({ displayName: "", name: "" }, "fallback"),
      "fallback",
    );
  });

  it("falls back to value when neither name nor displayName exists", () => {
    assert.equal(pickFirstString({ value: "v" }), "v");
  });

  it("returns empty string when nothing qualifies", () => {
    assert.equal(pickFirstString(null, "", undefined), "");
  });

  it("treats whitespace-only strings as empty", () => {
    assert.equal(pickFirstString("   ", "real"), "real");
  });
});

describe("asText", () => {
  it("returns string values unchanged", () => {
    assert.equal(asText("hello"), "hello");
  });

  it("stringifies numbers and booleans", () => {
    assert.equal(asText(42), "42");
    assert.equal(asText(true), "true");
    assert.equal(asText(false), "false");
  });

  it("returns empty string for nullish values", () => {
    assert.equal(asText(null), "");
    assert.equal(asText(undefined), "");
  });

  it("JSON-encodes objects and arrays", () => {
    assert.equal(asText({ a: 1 }), '{"a":1}');
    assert.equal(asText([1, 2]), "[1,2]");
  });

  it("returns empty string for unstringifiable values (circular)", () => {
    const a = {};
    a.self = a;
    assert.equal(asText(a), "");
  });
});
