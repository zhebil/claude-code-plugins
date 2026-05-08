import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  getProviderConfig,
  getTrustedProjects,
  isProjectTrusted,
  isProviderEnabled,
  loadConfig,
} from "../../../hooks/lib/config.mjs";

let tempDir;
const originalDataDir = process.env.CLAUDE_PLUGIN_DATA;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "auto-enrich-config-test-"));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = originalDataDir;
  await rm(tempDir, { recursive: true, force: true });
});

describe("getConfigPath", () => {
  it("uses $CLAUDE_PLUGIN_DATA/config.json when env is set", () => {
    assert.equal(getConfigPath(), join(tempDir, "config.json"));
  });

  it("falls back to ~/.claude/auto-enrich.json without the env var", () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const expected = join(process.env.HOME || process.cwd(), ".claude", "auto-enrich.json");
    assert.equal(getConfigPath(), expected);
  });
});

describe("loadConfig", () => {
  it("returns {} when file is absent", async () => {
    const cfg = await loadConfig();
    assert.deepEqual(cfg, {});
  });

  it("returns {} on invalid JSON", async () => {
    await writeFile(join(tempDir, "config.json"), "not json");
    const cfg = await loadConfig();
    assert.deepEqual(cfg, {});
  });

  it("loads a well-formed config", async () => {
    const payload = { providers: { jira: { enabled: false, cli: "jira-cli" } } };
    await writeFile(join(tempDir, "config.json"), JSON.stringify(payload));
    const cfg = await loadConfig();
    assert.deepEqual(cfg, payload);
  });
});

describe("isProviderEnabled", () => {
  it("defaults to true for unknown providers", () => {
    assert.equal(isProviderEnabled({}, "jira"), true);
    assert.equal(isProviderEnabled({ providers: {} }, "jira"), true);
  });

  it("returns true when entry exists without enabled key", () => {
    assert.equal(isProviderEnabled({ providers: { jira: { cli: "acli" } } }, "jira"), true);
  });

  it("returns false only when explicitly disabled", () => {
    assert.equal(isProviderEnabled({ providers: { jira: { enabled: false } } }, "jira"), false);
  });

  it("treats malformed entries as enabled (forgiving default)", () => {
    assert.equal(isProviderEnabled({ providers: { jira: "yes" } }, "jira"), true);
  });
});

describe("getProviderConfig", () => {
  it("returns {} when missing", () => {
    assert.deepEqual(getProviderConfig({}, "jira"), {});
  });

  it("returns the provider sub-object", () => {
    const cfg = { providers: { jira: { cli: "jira-cli" } } };
    assert.deepEqual(getProviderConfig(cfg, "jira"), { cli: "jira-cli" });
  });

  it("returns {} for malformed entries", () => {
    assert.deepEqual(getProviderConfig({ providers: { jira: 42 } }, "jira"), {});
  });
});

describe("getTrustedProjects", () => {
  it("returns [] when missing", () => {
    assert.deepEqual(getTrustedProjects({}), []);
  });

  it("returns [] when not an array", () => {
    assert.deepEqual(getTrustedProjects({ trustedProjects: "/tmp/x" }), []);
  });

  it("returns the list when well-formed", () => {
    const cfg = { trustedProjects: ["/a", "/b"] };
    assert.deepEqual(getTrustedProjects(cfg), ["/a", "/b"]);
  });

  it("drops non-string and empty-string entries silently", () => {
    const cfg = { trustedProjects: ["/a", "", 42, null, "/b"] };
    assert.deepEqual(getTrustedProjects(cfg), ["/a", "/b"]);
  });
});

describe("isProjectTrusted", () => {
  it("returns false when list is empty", () => {
    assert.equal(isProjectTrusted({}, "/tmp/x"), false);
  });

  it("returns true on exact resolved match", () => {
    const cfg = { trustedProjects: ["/tmp/x"] };
    assert.equal(isProjectTrusted(cfg, "/tmp/x"), true);
  });

  it("normalizes trailing slash via path.resolve", () => {
    const cfg = { trustedProjects: ["/tmp/x/"] };
    assert.equal(isProjectTrusted(cfg, "/tmp/x"), true);
  });

  it("treats `.` as the resolved cwd", () => {
    const cfg = { trustedProjects: [process.cwd()] };
    assert.equal(isProjectTrusted(cfg, "."), true);
  });

  it("does NOT trust subdirectories of a trusted entry", () => {
    const cfg = { trustedProjects: ["/tmp/parent"] };
    assert.equal(isProjectTrusted(cfg, "/tmp/parent/sub"), false);
  });

  it("does NOT trust parent of a trusted entry", () => {
    const cfg = { trustedProjects: ["/tmp/parent/sub"] };
    assert.equal(isProjectTrusted(cfg, "/tmp/parent"), false);
  });

  it("returns false for empty / non-string cwd", () => {
    const cfg = { trustedProjects: ["/tmp/x"] };
    assert.equal(isProjectTrusted(cfg, ""), false);
    assert.equal(isProjectTrusted(cfg, null), false);
  });

  it("ignores garbage entries when checking", () => {
    const cfg = { trustedProjects: [42, "", "/tmp/x"] };
    assert.equal(isProjectTrusted(cfg, "/tmp/x"), true);
  });
});
