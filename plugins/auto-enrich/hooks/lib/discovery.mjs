import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { safeJsonParse } from "./json.mjs";

const SUPPORTED_API_VERSION = 1;
const FILE_SUFFIX = ".provider.mjs";

/**
 * @typedef {Object} DiscoveryManifest
 * @property {number} loadedAt Epoch ms when SessionStart wrote the file.
 * @property {string[]} paths Absolute paths to validated `.provider.mjs`
 *   files. Each is safe to `await import()`.
 */

/**
 * Default discovery directory: `~/.claude/auto-enrich/providers/`.
 * User-global, deliberately not per-repo - per-repo would let cloned
 * code execute inside the hook process at every prompt.
 *
 * @returns {string}
 */
export function getDiscoveryDir() {
  const home = process.env.HOME || process.cwd();
  return join(home, ".claude", "auto-enrich", "providers");
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
 * Scan the discovery directory, validate every `*.provider.mjs` against
 * the contract, and return the list of accepted paths plus a parallel
 * array of human-readable warnings for files that were skipped.
 *
 * Built-in names are passed in so we can reject collisions with the
 * shipped providers - the orchestrator wouldn't know which one to call.
 *
 * @param {Object} options
 * @param {Set<string>} options.builtinNames Names registered statically.
 * @param {string} [options.dir] Override the scan dir (used in tests).
 * @returns {Promise<{paths: string[], warnings: string[]}>}
 */
export async function discoverProviders({ builtinNames, dir = getDiscoveryDir() }) {
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
  const seenNames = new Set(builtinNames);
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
 * Atomically write the manifest. Caller passes the validated paths.
 *
 * @param {string[]} paths
 * @returns {Promise<void>}
 */
export async function writeManifest(paths) {
  const file = getManifestPath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = { loadedAt: Date.now(), paths };
  await writeFile(tmp, JSON.stringify(payload, null, 2));
  await rename(tmp, file);
}

/**
 * Read the manifest written by SessionStart. Returns an empty result
 * when the file doesn't exist (first run, or no custom providers
 * installed).
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
    return { loadedAt: 0, paths: [] };
  }
  const parsed = safeJsonParse(raw);
  if (!parsed || !Array.isArray(parsed.paths)) return { loadedAt: 0, paths: [] };
  return { loadedAt: Number(parsed.loadedAt) || 0, paths: parsed.paths.filter((p) => typeof p === "string") };
}

/**
 * Dynamic-import every path in the manifest and return the resolved
 * provider objects. Files that fail to import (deleted between
 * SessionStart and now, or threw on load) are skipped silently with a
 * stderr warning - we already validated them once so this should be
 * rare.
 *
 * Defense-in-depth: even though SessionStart validated, we re-check
 * apiVersion + name + required functions here so a compromised
 * manifest can't slip in arbitrary objects.
 *
 * @param {Set<string>} builtinNames
 * @returns {Promise<import("../providers/index.mjs").Provider[]>}
 */
export async function loadCustomProviders(builtinNames) {
  const { paths } = await readManifest();
  if (!paths.length) return [];
  const loaded = [];
  const taken = new Set(builtinNames);
  for (const path of paths) {
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
