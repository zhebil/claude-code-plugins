import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { descriptionToMarkdown } from "../../../hooks/lib/adf.mjs";

const text = (value) => ({ type: "text", text: value });
const para = (...children) => ({ type: "paragraph", content: children });
const doc = (...children) => ({ type: "doc", content: children });

describe("descriptionToMarkdown", () => {
  it("returns empty string for null/undefined", () => {
    assert.equal(descriptionToMarkdown(null), "");
    assert.equal(descriptionToMarkdown(undefined), "");
  });

  it("returns trimmed string for plain string input (legacy Jira)", () => {
    assert.equal(descriptionToMarkdown("  hello  "), "hello");
  });

  it("returns empty string for non-ADF objects", () => {
    assert.equal(descriptionToMarkdown({ foo: "bar" }), "");
  });

  it("renders a simple paragraph", () => {
    const adf = doc(para(text("hello world")));
    assert.equal(descriptionToMarkdown(adf), "hello world");
  });

  it("renders headings with # prefix", () => {
    const adf = doc({
      type: "heading",
      attrs: { level: 2 },
      content: [text("Title")],
    });
    assert.equal(descriptionToMarkdown(adf), "## Title");
  });

  it("clamps heading levels to 1-6", () => {
    const adf = doc({
      type: "heading",
      attrs: { level: 9 },
      content: [text("Big")],
    });
    assert.equal(descriptionToMarkdown(adf), "###### Big");
  });

  it("renders bullet lists", () => {
    const adf = doc({
      type: "bulletList",
      content: [
        { type: "listItem", content: [para(text("one"))] },
        { type: "listItem", content: [para(text("two"))] },
      ],
    });
    assert.equal(descriptionToMarkdown(adf), "- one\n- two");
  });

  it("renders ordered lists with numeric markers", () => {
    const adf = doc({
      type: "orderedList",
      content: [
        { type: "listItem", content: [para(text("a"))] },
        { type: "listItem", content: [para(text("b"))] },
      ],
    });
    assert.equal(descriptionToMarkdown(adf), "1. a\n2. b");
  });

  it("applies marks to text nodes", () => {
    const node = (value, marks) => ({ type: "text", text: value, marks });
    const adf = doc(
      para(
        node("bold", [{ type: "strong" }]),
        text(" "),
        node("ital", [{ type: "em" }]),
        text(" "),
        node("link", [{ type: "link", attrs: { href: "https://x.test" } }]),
      ),
    );
    assert.equal(
      descriptionToMarkdown(adf),
      "**bold** *ital* [link](https://x.test)",
    );
  });

  it("renders code blocks with language", () => {
    const adf = doc({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [text("const x = 1")],
    });
    assert.match(descriptionToMarkdown(adf), /```ts\nconst x = 1\n```/);
  });

  it("renders blockquote with > prefix", () => {
    const adf = doc({
      type: "blockquote",
      content: [para(text("quoted"))],
    });
    assert.equal(descriptionToMarkdown(adf), "> quoted");
  });

  it("collapses 3+ blank lines to a single blank line", () => {
    const adf = doc(para(text("a")), para(text("")), para(text("b")));
    const out = descriptionToMarkdown(adf);
    assert.ok(!/\n{3,}/.test(out), `unexpected long blank run in: ${JSON.stringify(out)}`);
  });

  it("falls back to JSON code block for atomic unknown nodes", () => {
    const adf = doc({
      type: "mediaSingle",
      attrs: { layout: "center" },
    });
    const out = descriptionToMarkdown(adf);
    assert.match(out, /```json/);
    assert.match(out, /"type": "mediaSingle"/);
    assert.match(out, /"layout": "center"/);
  });

  it("renders children for unknown wrapper nodes when they have content", () => {
    const adf = doc({
      type: "futureWrapperType",
      content: [para(text("hello"))],
    });
    const out = descriptionToMarkdown(adf);
    assert.equal(out, "hello");
    assert.ok(!out.includes("```json"));
  });

  it("caps deeply nested ADF without blowing the stack", () => {
    let node = text("leaf");
    for (let i = 0; i < 5000; i++) {
      node = { type: "blockquote", content: [node] };
    }
    const adf = doc(node);
    const out = descriptionToMarkdown(adf);
    assert.match(out, /truncated: ADF too deeply nested/);
  });

  it("caps oversize output at 12K chars with a truncation marker", () => {
    const big = "x".repeat(20000);
    const adf = doc(para(text(big)));
    const out = descriptionToMarkdown(adf);
    assert.ok(out.length <= 12000 + 50, `output too long: ${out.length}`);
    assert.match(out, /\[…truncated\]/);
  });

  it("caps oversize plain string descriptions", () => {
    const big = "y".repeat(20000);
    const out = descriptionToMarkdown(big);
    assert.ok(out.length <= 12000 + 50, `output too long: ${out.length}`);
    assert.match(out, /\[…truncated\]/);
  });
});
