import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  getProjectConfigPath,
  getProviderConfig,
  getTrustedProjects,
  isProjectTrusted,
  isProviderEnabled,
  loadConfig,
  loadEffectiveConfig,
  loadProjectConfig,
  mergeConfigs,
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

describe("getProjectConfigPath", () => {
  it("returns <cwd>/.claude/auto-enrich.json for a real path", () => {
    assert.equal(getProjectConfigPath("/tmp/proj"), join("/tmp/proj", ".claude", "auto-enrich.json"));
  });

  it("returns null for empty / non-string cwd", () => {
    assert.equal(getProjectConfigPath(""), null);
    assert.equal(getProjectConfigPath(null), null);
    assert.equal(getProjectConfigPath(undefined), null);
  });

  it("resolves relative paths so the result is absolute", () => {
    const resolved = getProjectConfigPath(".");
    assert.ok(resolved && resolved.startsWith("/"));
    assert.ok(resolved.endsWith(join(".claude", "auto-enrich.json")));
  });
});

describe("loadProjectConfig", () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "auto-enrich-projcfg-"));
    await mkdir(join(projectDir, ".claude"), { recursive: true });
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns {} when the project file is absent", async () => {
    const cfg = await loadProjectConfig(projectDir);
    assert.deepEqual(cfg, {});
  });

  it("returns {} on invalid JSON", async () => {
    await writeFile(join(projectDir, ".claude", "auto-enrich.json"), "not json");
    const cfg = await loadProjectConfig(projectDir);
    assert.deepEqual(cfg, {});
  });

  it("loads a well-formed project config", async () => {
    const payload = { providers: { jira: { enabled: false } } };
    await writeFile(join(projectDir, ".claude", "auto-enrich.json"), JSON.stringify(payload));
    const cfg = await loadProjectConfig(projectDir);
    assert.deepEqual(cfg, payload);
  });

  it("strips trustedProjects from project config (security: no self-grant)", async () => {
    const payload = {
      providers: { jira: { enabled: false } },
      trustedProjects: ["/anywhere"],
    };
    await writeFile(join(projectDir, ".claude", "auto-enrich.json"), JSON.stringify(payload));
    const cfg = await loadProjectConfig(projectDir);
    assert.deepEqual(cfg, { providers: { jira: { enabled: false } } });
    assert.equal("trustedProjects" in cfg, false);
  });

  it("returns {} for null/empty cwd", async () => {
    assert.deepEqual(await loadProjectConfig(""), {});
    assert.deepEqual(await loadProjectConfig(null), {});
  });
});

describe("mergeConfigs", () => {
  it("returns {} when both inputs are empty/null", () => {
    assert.deepEqual(mergeConfigs(null, null), {});
    assert.deepEqual(mergeConfigs({}, {}), {});
  });

  it("returns global as-is when project is empty", () => {
    const g = { providers: { jira: { enabled: true, cli: "acli" } } };
    assert.deepEqual(mergeConfigs(g, {}), g);
  });

  it("project provider keys override global, missing keys fall through", () => {
    const g = { providers: { jira: { enabled: true, cli: "acli" } } };
    const p = { providers: { jira: { enabled: false } } };
    const merged = mergeConfigs(g, p);
    // jira.enabled comes from project, jira.cli still comes from global
    assert.deepEqual(merged.providers.jira, { enabled: false, cli: "acli" });
  });

  it("project can override jira.cli without touching enabled", () => {
    const g = { providers: { jira: { enabled: true, cli: "acli" } } };
    const p = { providers: { jira: { cli: "jira-cli" } } };
    const merged = mergeConfigs(g, p);
    assert.deepEqual(merged.providers.jira, { enabled: true, cli: "jira-cli" });
  });

  it("merges providers that exist only in global or only in project", () => {
    const g = { providers: { jira: { enabled: true } } };
    const p = { providers: { sentry: { enabled: false } } };
    const merged = mergeConfigs(g, p);
    assert.deepEqual(merged.providers, {
      jira: { enabled: true },
      sentry: { enabled: false },
    });
  });

  it("preserves global trustedProjects (project list never participates)", () => {
    const g = { trustedProjects: ["/a"], providers: {} };
    const p = { trustedProjects: ["/should-be-ignored"], providers: {} };
    const merged = mergeConfigs(g, p);
    assert.deepEqual(merged.trustedProjects, ["/a"]);
  });

  it("treats malformed provider entries as empty objects when merging", () => {
    const g = { providers: { jira: "garbage" } };
    const p = { providers: { jira: { enabled: false } } };
    const merged = mergeConfigs(g, p);
    assert.deepEqual(merged.providers.jira, { enabled: false });
  });
});

describe("loadEffectiveConfig", () => {
  let projectDir;
  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "auto-enrich-effcfg-"));
    await mkdir(join(projectDir, ".claude"), { recursive: true });
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns global + project + merged when both exist", async () => {
    await writeFile(
      join(tempDir, "config.json"),
      JSON.stringify({ providers: { jira: { enabled: true, cli: "acli" } } }),
    );
    await writeFile(
      join(projectDir, ".claude", "auto-enrich.json"),
      JSON.stringify({ providers: { jira: { enabled: false } } }),
    );
    const { global, project, effective } = await loadEffectiveConfig(projectDir);
    assert.deepEqual(global.providers.jira, { enabled: true, cli: "acli" });
    assert.deepEqual(project.providers.jira, { enabled: false });
    assert.deepEqual(effective.providers.jira, { enabled: false, cli: "acli" });
  });

  it("returns global-only when project file is absent", async () => {
    await writeFile(
      join(tempDir, "config.json"),
      JSON.stringify({ providers: { jira: { enabled: true } } }),
    );
    const { global, project, effective } = await loadEffectiveConfig(projectDir);
    assert.deepEqual(project, {});
    assert.deepEqual(effective.providers.jira, global.providers.jira);
  });

  it("project trustedProjects never reaches the merged config", async () => {
    await writeFile(join(tempDir, "config.json"), JSON.stringify({ trustedProjects: ["/global"] }));
    await writeFile(
      join(projectDir, ".claude", "auto-enrich.json"),
      JSON.stringify({ trustedProjects: ["/from-project"], providers: { jira: { enabled: false } } }),
    );
    const { effective } = await loadEffectiveConfig(projectDir);
    assert.deepEqual(effective.trustedProjects, ["/global"]);
    assert.equal(effective.trustedProjects.includes("/from-project"), false);
  });
});
