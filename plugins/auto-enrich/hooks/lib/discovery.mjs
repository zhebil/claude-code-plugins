import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { safeJsonParse } from "./json.mjs";

const SUPPORTED_API_VERSION = 1;
const FILE_SUFFIX = ".provider.mjs";

/**
 * @typedef {"global" | "project"} ProviderSource
 *
 * @typedef {Object} ManifestEntry
 * @property {string} path Absolute path, safe to `await import()`.
 * @property {ProviderSource} source Where it was discovered. `global`
 *   means `~/.claude/auto-enrich/providers/`; `project` means
 *   `<projectRoot>/.claude/auto-enrich/providers/` (only present for
 *   trusted projects - see `isProjectTrusted`).
 *
 * @typedef {Object} DiscoveryManifest
 * @property {number} loadedAt Epoch ms when SessionStart wrote the file.
 * @property {ManifestEntry[]} entries Validated `.provider.mjs` files
 *   in load order: global first, then project.
 */

/**
 * Default global discovery directory: `~/.claude/auto-enrich/providers/`.
 *
 * @returns {string}
 */
export function getDiscoveryDir() {
  const home = process.env.HOME || process.cwd();
  return join(home, ".claude", "auto-enrich", "providers");
}

/**
 * Per-project discovery directory under the given working directory.
 * Loaded only when the project is on the user's trust list (see
 * `isProjectTrusted`).
 *
 * @param {string} cwd
 * @returns {string}
 */
export function getProjectDiscoveryDir(cwd) {
  return join(cwd, ".claude", "auto-enrich", "providers");
}

/**
 * Path to the on-disk manifest. Lives next to the seen-id cache.
 *
 * @returns {string}
 */
export function getManifestPath() {
  const base = process.env.CLAUDE_PLUGIN_DATA
    || join(process.env.HOME || process.cwd(), ".cache", "claude-auto-enrich");
  return join(base, "discovery.json");
}

/**
 * Scan a single discovery directory and validate every `*.provider.mjs`
 * against the contract. Returns the accepted paths plus a parallel
 * array of human-readable warnings for files that were skipped.
 *
 * `seenNames` is mutated in place: each accepted provider's name is
 * added so callers can chain multiple scans (built-ins -> global ->
 * project) and reject collisions across all of them.
 *
 * @param {Object} options
 * @param {string} options.dir Directory to scan.
 * @param {Set<string>} options.seenNames Names already taken; mutated.
 * @returns {Promise<{paths: string[], warnings: string[]}>}
 */
async function scanDir({ dir, seenNames }) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return { paths: [], warnings: [] };
    return { paths: [], warnings: [`auto-enrich: cannot read ${dir} (${error?.code ?? error})`] };
  }
  const candidates = entries
    .filter((name) => name.endsWith(FILE_SUFFIX))
    .map((name) => resolve(dir, name))
    .sort();

  const paths = [];
  const warnings = [];
  for (const path of candidates) {
    const result = await validateProviderFile(path, seenNames);
    if (result.ok) {
      paths.push(path);
      seenNames.add(result.name);
    } else {
      warnings.push(`auto-enrich: skipped ${path}: ${result.reason}`);
    }
  }
  return { paths, warnings };
}

/**
 * Scan the global discovery directory and (optionally) a project
 * discovery directory, validating every `*.provider.mjs` against the
 * contract. Built-ins win over global, global wins over project: a
 * name registered earlier in that order causes later collisions to be
 * rejected with a warning.
 *
 * Returns a manifest-ready `entries` array tagged with each provider's
 * source plus warnings. Backward-compat callers that want only the
 * paths can read `entries.map(e => e.path)`.
 *
 * @param {Object} options
 * @param {Set<string>} options.builtinNames Names registered statically.
 * @param {string} [options.dir] Override the global scan dir (tests).
 * @param {string} [options.projectDir] Optional project scan dir;
 *   omitted/empty disables project discovery.
 * @returns {Promise<{entries: ManifestEntry[], paths: string[], warnings: string[]}>}
 */
export async function discoverProviders({ builtinNames, dir = getDiscoveryDir(), projectDir = null }) {
  const seenNames = new Set(builtinNames);
  const entries = [];
  const warnings = [];

  const global = await scanDir({ dir, seenNames });
  warnings.push(...global.warnings);
  for (const path of global.paths) entries.push({ path, source: "global" });

  if (projectDir) {
    const project = await scanDir({ dir: projectDir, seenNames });
    warnings.push(...project.warnings);
    for (const path of project.paths) entries.push({ path, source: "project" });
  }

  return { entries, paths: entries.map((e) => e.path), warnings };
}

/**
 * Import a candidate file and verify the exported object satisfies the
 * provider contract. Returns `{ ok: true, name }` on success or
 * `{ ok: false, reason }` on any structural failure. Never throws.
 *
 * Side effects: none on disk; the dynamic import does load the module
 * code, which is unavoidable - validation requires inspecting the
 * exported object.
 *
 * @param {string} absPath
 * @param {Set<string>} reservedNames Names already taken (built-ins +
 *   previously-validated custom providers).
 * @returns {Promise<{ok: true, name: string} | {ok: false, reason: string}>}
 */
export async function validateProviderFile(absPath, reservedNames) {
  let mod;
  try {
    mod = await import(pathToFileURL(absPath).href);
  } catch (error) {
    return { ok: false, reason: `import failed (${error?.message ?? error})` };
  }
  const provider = mod.default ?? mod.provider;
  if (!provider || typeof provider !== "object") {
    return { ok: false, reason: "no default export or named `provider` export" };
  }
  if (provider.apiVersion !== SUPPORTED_API_VERSION) {
    return {
      ok: false,
      reason: `apiVersion must be ${SUPPORTED_API_VERSION}, got ${JSON.stringify(provider.apiVersion)}`,
    };
  }
  if (typeof provider.name !== "string" || !provider.name) {
    return { ok: false, reason: "name must be a non-empty string" };
  }
  if (reservedNames.has(provider.name)) {
    return { ok: false, reason: `name "${provider.name}" collides with an existing provider` };
  }
  for (const fn of ["detect", "fetch", "summarize"]) {
    if (typeof provider[fn] !== "function") {
      return { ok: false, reason: `${fn} must be a function` };
    }
  }
  if (provider.prepare !== undefined && typeof provider.prepare !== "function") {
    return { ok: false, reason: "prepare must be a function when present" };
  }
  return { ok: true, name: provider.name };
}

/**
 * Atomically write the manifest. Accepts either the new tagged-entries
 * form (preferred) or a flat path list (treated as all-global, kept
 * for backward compat with older callers and tests).
 *
 * The on-disk schema records both `entries` (source-tagged) and
 * `paths` (flat) so older readers degrade gracefully.
 *
 * @param {ManifestEntry[] | string[]} input
 * @returns {Promise<void>}
 */
export async function writeManifest(input) {
  const entries = normalizeManifestInput(input);
  const file = getManifestPath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = {
    loadedAt: Date.now(),
    entries,
    paths: entries.map((e) => e.path),
  };
  await writeFile(tmp, JSON.stringify(payload, null, 2));
  await rename(tmp, file);
}

function normalizeManifestInput(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (typeof item === "string") return { path: item, source: "global" };
      if (item && typeof item === "object" && typeof item.path === "string") {
        const source = item.source === "project" ? "project" : "global";
        return { path: item.path, source };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Read the manifest written by SessionStart. Returns an empty result
 * when the file doesn't exist (first run, or no custom providers
 * installed). Tolerates the legacy `paths`-only schema for forward
 * compat with manifests written by older versions.
 *
 * @returns {Promise<DiscoveryManifest>}
 */
export async function readManifest() {
  let raw;
  try {
    raw = await readFile(getManifestPath(), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(`auto-enrich: discovery manifest unreadable (${error?.code ?? error})\n`);
    }
    return { loadedAt: 0, entries: [] };
  }
  const parsed = safeJsonParse(raw);
  if (!parsed) return { loadedAt: 0, entries: [] };
  const loadedAt = Number(parsed.loadedAt) || 0;
  if (Array.isArray(parsed.entries)) {
    const entries = parsed.entries
      .filter((e) => e && typeof e === "object" && typeof e.path === "string")
      .map((e) => ({ path: e.path, source: e.source === "project" ? "project" : "global" }));
    return { loadedAt, entries };
  }
  if (Array.isArray(parsed.paths)) {
    const entries = parsed.paths
      .filter((p) => typeof p === "string")
      .map((path) => ({ path, source: "global" }));
    return { loadedAt, entries };
  }
  return { loadedAt: 0, entries: [] };
}

/**
 * Dynamic-import every entry in the manifest and return the resolved
 * provider objects in load order: global first, then project. Files
 * that fail to import (deleted between SessionStart and now, or threw
 * on load) are skipped silently with a stderr warning.
 *
 * Defense-in-depth: even though SessionStart validated, we re-check
 * apiVersion + name + required functions here so a compromised
 * manifest can't slip in arbitrary objects.
 *
 * Project-source entries are dropped before import when
 * `options.allowProject` is false (i.e. the cwd is no longer trusted
 * at prompt time).
 *
 * @param {Set<string>} builtinNames
 * @param {Object} [options]
 * @param {boolean} [options.allowProject] Defaults to `true` for
 *   backward compat; orchestrator passes the live trust check.
 * @returns {Promise<import("../providers/index.mjs").Provider[]>}
 */
export async function loadCustomProviders(builtinNames, { allowProject = true } = {}) {
  const { entries } = await readManifest();
  if (!entries.length) return [];
  const filtered = allowProject ? entries : entries.filter((e) => e.source !== "project");
  const loaded = [];
  const taken = new Set(builtinNames);
  for (const { path } of filtered) {
    let mod;
    try {
      mod = await import(pathToFileURL(path).href);
    } catch (error) {
      process.stderr.write(`auto-enrich: failed to load ${path} (${error?.message ?? error})\n`);
      continue;
    }
    const provider = mod.default ?? mod.provider;
    if (
      !provider
      || provider.apiVersion !== SUPPORTED_API_VERSION
      || typeof provider.name !== "string"
      || !provider.name
      || taken.has(provider.name)
      || typeof provider.detect !== "function"
      || typeof provider.fetch !== "function"
      || typeof provider.summarize !== "function"
    ) {
      process.stderr.write(`auto-enrich: ${path} no longer satisfies provider contract; skipping\n`);
      continue;
    }
    taken.add(provider.name);
    loaded.push(provider);
  }
  return loaded;
}

/**
 * Used by tests to assert the directory exists or read its contents.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
