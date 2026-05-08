import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProviders,
  loadCustomProviders,
  readManifest,
  validateProviderFile,
  writeManifest,
  getManifestPath,
} from "../../../hooks/lib/discovery.mjs";

let scanDir;
let dataDir;
const originalDataDir = process.env.CLAUDE_PLUGIN_DATA;

beforeEach(async () => {
  scanDir = await mkdtemp(join(tmpdir(), "auto-enrich-discover-"));
  dataDir = await mkdtemp(join(tmpdir(), "auto-enrich-data-"));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = originalDataDir;
  await rm(scanDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

const validProviderSrc = (name) => `
export default {
  apiVersion: 1,
  name: ${JSON.stringify(name)},
  detect(text, codeRanges, ctx) { return []; },
  async fetch(match, ctx) { return null; },
  summarize(match) { return ${JSON.stringify(name)}; },
};
`;

describe("validateProviderFile", () => {
  it("accepts a well-formed default export", async () => {
    const path = join(scanDir, "good.provider.mjs");
    await writeFile(path, validProviderSrc("good"));
    const result = await validateProviderFile(path, new Set());
    assert.deepEqual(result, { ok: true, name: "good" });
  });

  it("accepts a named `provider` export", async () => {
    const path = join(scanDir, "named.provider.mjs");
    await writeFile(path, `
      export const provider = {
        apiVersion: 1,
        name: "named",
        detect: () => [],
        fetch: async () => null,
        summarize: () => "x",
      };
    `);
    const result = await validateProviderFile(path, new Set());
    assert.deepEqual(result, { ok: true, name: "named" });
  });

  it("rejects unsupported apiVersion", async () => {
    const path = join(scanDir, "bad-version.provider.mjs");
    await writeFile(path, `export default { apiVersion: 2, name: "x", detect:()=>[], fetch:async()=>null, summarize:()=>"" };`);
    const result = await validateProviderFile(path, new Set());
    assert.equal(result.ok, false);
    assert.match(result.reason, /apiVersion/);
  });

  it("rejects missing apiVersion", async () => {
    const path = join(scanDir, "no-version.provider.mjs");
    await writeFile(path, `export default { name: "x", detect:()=>[], fetch:async()=>null, summarize:()=>"" };`);
    const result = await validateProviderFile(path, new Set());
    assert.equal(result.ok, false);
    assert.match(result.reason, /apiVersion/);
  });

  it("rejects empty name", async () => {
    const path = join(scanDir, "empty-name.provider.mjs");
    await writeFile(path, `export default { apiVersion: 1, name: "", detect:()=>[], fetch:async()=>null, summarize:()=>"" };`);
    const result = await validateProviderFile(path, new Set());
    assert.equal(result.ok, false);
    assert.match(result.reason, /name/);
  });

  it("rejects collision with reserved name", async () => {
    const path = join(scanDir, "dup.provider.mjs");
    await writeFile(path, validProviderSrc("jira"));
    const result = await validateProviderFile(path, new Set(["jira"]));
    assert.equal(result.ok, false);
    assert.match(result.reason, /collides/);
  });

  it("rejects when required functions are missing", async () => {
    const path = join(scanDir, "no-detect.provider.mjs");
    await writeFile(path, `export default { apiVersion: 1, name: "x", fetch:async()=>null, summarize:()=>"" };`);
    const result = await validateProviderFile(path, new Set());
    assert.equal(result.ok, false);
    assert.match(result.reason, /detect/);
  });

  it("rejects when prepare is present but not a function", async () => {
    const path = join(scanDir, "bad-prepare.provider.mjs");
    await writeFile(path, `export default { apiVersion: 1, name: "x", prepare: 42, detect:()=>[], fetch:async()=>null, summarize:()=>"" };`);
    const result = await validateProviderFile(path, new Set());
    assert.equal(result.ok, false);
    assert.match(result.reason, /prepare/);
  });

  it("returns a reason when import throws", async () => {
    const path = join(scanDir, "throws.provider.mjs");
    await writeFile(path, `throw new Error("kaboom");`);
    const result = await validateProviderFile(path, new Set());
    assert.equal(result.ok, false);
    assert.match(result.reason, /import failed/);
  });
});

describe("discoverProviders", () => {
  it("returns empty when the dir is missing", async () => {
    const result = await discoverProviders({
      builtinNames: new Set(),
      dir: join(scanDir, "does-not-exist"),
    });
    assert.deepEqual(result, { entries: [], paths: [], warnings: [] });
  });

  it("returns only `*.provider.mjs` files in sorted order", async () => {
    await writeFile(join(scanDir, "b.provider.mjs"), validProviderSrc("b"));
    await writeFile(join(scanDir, "a.provider.mjs"), validProviderSrc("a"));
    await writeFile(join(scanDir, "ignored.mjs"), "garbage");
    await writeFile(join(scanDir, "readme.md"), "ignored");
    const { paths, warnings } = await discoverProviders({
      builtinNames: new Set(),
      dir: scanDir,
    });
    assert.equal(warnings.length, 0);
    assert.equal(paths.length, 2);
    assert.match(paths[0], /a\.provider\.mjs$/);
    assert.match(paths[1], /b\.provider\.mjs$/);
  });

  it("collects warnings for invalid files but keeps the valid ones", async () => {
    await writeFile(join(scanDir, "good.provider.mjs"), validProviderSrc("good"));
    await writeFile(join(scanDir, "bad.provider.mjs"), `export default { name: "bad" };`);
    const { paths, warnings } = await discoverProviders({
      builtinNames: new Set(),
      dir: scanDir,
    });
    assert.equal(paths.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /bad\.provider\.mjs/);
  });

  it("rejects custom files that collide with built-in names", async () => {
    await writeFile(join(scanDir, "shadow.provider.mjs"), validProviderSrc("jira"));
    const { paths, warnings } = await discoverProviders({
      builtinNames: new Set(["jira"]),
      dir: scanDir,
    });
    assert.equal(paths.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /collides/);
  });

  it("tags entries with their source (global)", async () => {
    await writeFile(join(scanDir, "g.provider.mjs"), validProviderSrc("g"));
    const { entries } = await discoverProviders({
      builtinNames: new Set(),
      dir: scanDir,
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, "global");
  });

  it("scans project dir when provided, after global", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "auto-enrich-project-"));
    try {
      await writeFile(join(scanDir, "g.provider.mjs"), validProviderSrc("g"));
      await writeFile(join(projectDir, "p.provider.mjs"), validProviderSrc("p"));
      const { entries, warnings } = await discoverProviders({
        builtinNames: new Set(),
        dir: scanDir,
        projectDir,
      });
      assert.equal(warnings.length, 0);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].source, "global");
      assert.match(entries[0].path, /g\.provider\.mjs$/);
      assert.equal(entries[1].source, "project");
      assert.match(entries[1].path, /p\.provider\.mjs$/);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("project entry is rejected when name collides with global", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "auto-enrich-project-"));
    try {
      await writeFile(join(scanDir, "g.provider.mjs"), validProviderSrc("dup"));
      await writeFile(join(projectDir, "p.provider.mjs"), validProviderSrc("dup"));
      const { entries, warnings } = await discoverProviders({
        builtinNames: new Set(),
        dir: scanDir,
        projectDir,
      });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].source, "global");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /collides/);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("project entry is rejected when name collides with built-in", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "auto-enrich-project-"));
    try {
      await writeFile(join(projectDir, "p.provider.mjs"), validProviderSrc("jira"));
      const { entries, warnings } = await discoverProviders({
        builtinNames: new Set(["jira"]),
        dir: scanDir,
        projectDir,
      });
      assert.equal(entries.length, 0);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /collides/);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("missing project dir is silent (not an error)", async () => {
    await writeFile(join(scanDir, "g.provider.mjs"), validProviderSrc("g"));
    const { entries, warnings } = await discoverProviders({
      builtinNames: new Set(),
      dir: scanDir,
      projectDir: join(scanDir, "does-not-exist"),
    });
    assert.equal(warnings.length, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, "global");
  });
});

describe("writeManifest / readManifest", () => {
  it("round-trips a path list (legacy shape) as global entries", async () => {
    await writeManifest(["/a/x.mjs", "/b/y.mjs"]);
    const manifest = await readManifest();
    assert.deepEqual(
      manifest.entries,
      [
        { path: "/a/x.mjs", source: "global" },
        { path: "/b/y.mjs", source: "global" },
      ],
    );
    assert.ok(manifest.loadedAt > 0);
    assert.equal(getManifestPath(), join(dataDir, "discovery.json"));
  });

  it("round-trips tagged entries preserving source", async () => {
    await writeManifest([
      { path: "/a/x.mjs", source: "global" },
      { path: "/p/y.mjs", source: "project" },
    ]);
    const manifest = await readManifest();
    assert.deepEqual(
      manifest.entries,
      [
        { path: "/a/x.mjs", source: "global" },
        { path: "/p/y.mjs", source: "project" },
      ],
    );
  });

  it("reads a legacy manifest with only `paths`", async () => {
    await writeFile(
      getManifestPath(),
      JSON.stringify({ loadedAt: 1, paths: ["/legacy/x.mjs"] }),
    );
    const manifest = await readManifest();
    assert.deepEqual(manifest.entries, [{ path: "/legacy/x.mjs", source: "global" }]);
  });

  it("returns an empty manifest when file is missing", async () => {
    const manifest = await readManifest();
    assert.deepEqual(manifest, { loadedAt: 0, entries: [] });
  });

  it("returns an empty manifest on malformed JSON", async () => {
    const path = getManifestPath();
    await writeFile(path, "not json");
    const manifest = await readManifest();
    assert.deepEqual(manifest, { loadedAt: 0, entries: [] });
  });
});

describe("loadCustomProviders", () => {
  it("returns an empty array when manifest is empty", async () => {
    const out = await loadCustomProviders(new Set());
    assert.deepEqual(out, []);
  });

  it("loads validated providers from manifest", async () => {
    const path = join(scanDir, "real.provider.mjs");
    await writeFile(path, validProviderSrc("real"));
    await writeManifest([path]);
    const out = await loadCustomProviders(new Set());
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "real");
  });

  it("skips a manifest entry that no longer exists on disk", async () => {
    await writeManifest([join(scanDir, "missing.provider.mjs")]);
    const out = await loadCustomProviders(new Set());
    assert.equal(out.length, 0);
  });

  it("re-checks the contract at load time (defense-in-depth)", async () => {
    const path = join(scanDir, "tampered.provider.mjs");
    await writeFile(path, `export default { apiVersion: 1, name: "ok", detect:()=>[], fetch:async()=>null };`);
    await writeManifest([path]);
    const out = await loadCustomProviders(new Set());
    assert.equal(out.length, 0);
  });

  it("rejects a manifest entry whose name now collides with a built-in", async () => {
    const path = join(scanDir, "shadow.provider.mjs");
    await writeFile(path, validProviderSrc("jira"));
    await writeManifest([path]);
    const out = await loadCustomProviders(new Set(["jira"]));
    assert.equal(out.length, 0);
  });

  it("loads global + project entries in order when allowProject is true", async () => {
    const gPath = join(scanDir, "g.provider.mjs");
    const pPath = join(scanDir, "p.provider.mjs");
    await writeFile(gPath, validProviderSrc("g"));
    await writeFile(pPath, validProviderSrc("p"));
    await writeManifest([
      { path: gPath, source: "global" },
      { path: pPath, source: "project" },
    ]);
    const out = await loadCustomProviders(new Set());
    assert.deepEqual(out.map((p) => p.name), ["g", "p"]);
  });

  it("drops project entries when allowProject is false", async () => {
    const gPath = join(scanDir, "g.provider.mjs");
    const pPath = join(scanDir, "p.provider.mjs");
    await writeFile(gPath, validProviderSrc("g"));
    await writeFile(pPath, validProviderSrc("p"));
    await writeManifest([
      { path: gPath, source: "global" },
      { path: pPath, source: "project" },
    ]);
    const out = await loadCustomProviders(new Set(), { allowProject: false });
    assert.deepEqual(out.map((p) => p.name), ["g"]);
  });
});
