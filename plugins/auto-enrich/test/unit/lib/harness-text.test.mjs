import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripHarnessBlocks } from "../../../hooks/lib/harness-text.mjs";

describe("stripHarnessBlocks", () => {
  it("leaves typed text untouched", () => {
    const text = "look at https://github.com/me/proj/issues/3";
    assert.equal(stripHarnessBlocks(text), text);
  });

  it("blanks a prompt that is only a task notification", () => {
    const text = [
      "<task-notification>",
      "<task-id>a5e2568c9e4714963</task-id>",
      "<status>completed</status>",
      "<result>See https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md</result>",
      "</task-notification>",
    ].join("\n");
    assert.equal(stripHarnessBlocks(text).trim(), "");
  });

  it("keeps typed text around a system reminder", () => {
    const text = "check PROJ-1\n<system-reminder>\nsee PROJ-2\n</system-reminder>\nand PROJ-3";
    const stripped = stripHarnessBlocks(text);
    assert.match(stripped, /PROJ-1/);
    assert.match(stripped, /PROJ-3/);
    assert.doesNotMatch(stripped, /PROJ-2/);
  });

  it("strips tags that carry attributes", () => {
    const text = '<cross-session-message from="other">\nhttps://github.com/me/proj/issues/3\n</cross-session-message>';
    assert.equal(stripHarnessBlocks(text).trim(), "");
  });

  it("strips every block when several are present", () => {
    const text = [
      "<system-reminder>a PROJ-1</system-reminder>",
      "typed PROJ-2",
      "<task-notification>b PROJ-3</task-notification>",
      "<task-notification>c PROJ-4</task-notification>",
    ].join("\n");
    assert.equal(stripHarnessBlocks(text).trim(), "typed PROJ-2");
  });

  it("strips an unclosed block to the end of the text", () => {
    const text = "typed PROJ-1\n<task-notification>\nPROJ-2 never closed";
    assert.equal(stripHarnessBlocks(text).trim(), "typed PROJ-1");
  });

  it("ignores a harness tag mentioned mid-line", () => {
    const text = "why does <system-reminder> show up next to PROJ-1?";
    assert.equal(stripHarnessBlocks(text), text);
  });

  it("keeps pasted content, which the user supplied", () => {
    const text = '<pasted_content id="1">\nPROJ-1\n</pasted_content id="1">';
    assert.equal(stripHarnessBlocks(text), text);
  });
});
