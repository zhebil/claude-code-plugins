import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { safeJsonParse } from "./json.mjs";

/**
 * @typedef {Object} ProviderConfig
 * @property {boolean} [enabled] Defaults to `true` when omitted.
 *   Provider-specific keys (e.g. `cli`) may also live here; readers
 *   should treat unknown keys as opaque pass-through values.
 */

/**
 * @typedef {Object} AutoEnrichConfig
 * @property {Object<string, ProviderConfig>} [providers] Per-provider
 *   settings keyed by `provider.name`.
 * @property {string[]} [trustedProjects] Absolute project-root paths the
 *   user has opted in to project-level provider discovery for. Honoured
 *   only when set in the GLOBAL config; never read from in-repo files.
 */

/**
 * Resolve the on-disk config path. Honors `CLAUDE_PLUGIN_DATA` if set
 * (Claude Code's per-plugin data dir), otherwise falls back to a
 * user-discoverable location under `~/.claude/`.
 *
 * @returns {string} Absolute path to the JSON config file.
 */
export function getConfigPath() {
  if (process.env.CLAUDE_PLUGIN_DATA) {
    return join(process.env.CLAUDE_PLUGIN_DATA, "config.json");
  }
  return join(process.env.HOME || process.cwd(), ".claude", "auto-enrich.json");
}

/**
 * Load the config file. Returns an empty object when:
 *   - the file does not exist (first run / never configured),
 *   - the file is unreadable, or
 *   - the file is not valid JSON.
 *
 * Read errors other than ENOENT are surfaced on stderr so misconfig
 * doesn't silently hide the user's intent. The hook never blocks the
 * prompt over a bad config.
 *
 * @returns {Promise<AutoEnrichConfig>}
 */
export async function loadConfig() {
  let raw;
  try {
    raw = await readFile(getConfigPath(), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(`auto-enrich: config read failed (${error?.code ?? error}); using defaults\n`);
    }
    return {};
  }
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed;
}

/**
 * Whether a provider is enabled per config. Default is `true` so a
 * fresh install enriches everything.
 *
 * @param {AutoEnrichConfig} config
 * @param {string} providerName
 * @returns {boolean}
 */
export function isProviderEnabled(config, providerName) {
  const entry = config?.providers?.[providerName];
  if (!entry || typeof entry !== "object") return true;
  return entry.enabled !== false;
}

/**
 * Return the provider's config sub-object (always an object, possibly
 * empty). Lets providers read their own keys without each one
 * re-implementing the lookup.
 *
 * @param {AutoEnrichConfig} config
 * @param {string} providerName
 * @returns {ProviderConfig}
 */
export function getProviderConfig(config, providerName) {
  const entry = config?.providers?.[providerName];
  if (!entry || typeof entry !== "object") return {};
  return entry;
}

/**
 * Return the validated `trustedProjects` list from the global config.
 * Garbage entries (non-strings, empty strings) are dropped silently;
 * the remainder is returned as-is (no path resolution yet, callers do
 * exact-match against a resolved cwd).
 *
 * @param {AutoEnrichConfig} config
 * @returns {string[]}
 */
export function getTrustedProjects(config) {
  const raw = config?.trustedProjects;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry) => typeof entry === "string" && entry.length > 0);
}

/**
 * Whether the given working directory is on the user's trust list.
 * Match is exact against the resolved cwd - no prefix walk, no glob.
 * Trusting `/path/to/repo` does NOT imply trust for `/path/to/repo/sub`.
 *
 * @param {AutoEnrichConfig} config
 * @param {string} cwd
 * @returns {boolean}
 */
export function isProjectTrusted(config, cwd) {
  if (typeof cwd !== "string" || !cwd) return false;
  const target = resolve(cwd);
  for (const entry of getTrustedProjects(config)) {
    if (resolve(entry) === target) return true;
  }
  return false;
}

/**
 * Resolve the project-local config path. Project config sits at
 * `<cwd>/.claude/auto-enrich.json`, alongside the existing
 * `<cwd>/.claude/auto-enrich/providers/` convention.
 *
 * @param {string} cwd
 * @returns {string|null} Absolute path, or null if cwd is unusable.
 */
export function getProjectConfigPath(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  return join(resolve(cwd), ".claude", "auto-enrich.json");
}

/**
 * Load a project-local config. Same lenient behavior as `loadConfig`
 * (missing/unreadable/invalid file -> `{}`).
 *
 * `trustedProjects` is stripped before returning: a project must not be
 * able to grant itself custom-provider execution trust by editing its
 * own checked-in config. This is the same threat model that already
 * keeps trust read-only-from-global elsewhere; centralizing the strip
 * here means callers can't forget. A non-empty `trustedProjects` in a
 * project file emits a one-line stderr warning so the user notices it
 * was ignored rather than honored.
 *
 * @param {string} cwd
 * @returns {Promise<AutoEnrichConfig>}
 */
export async function loadProjectConfig(cwd) {
  const path = getProjectConfigPath(cwd);
  if (!path) return {};
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(`auto-enrich: project config read failed (${error?.code ?? error}); ignoring\n`);
    }
    return {};
  }
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") return {};
  if (Array.isArray(parsed.trustedProjects) && parsed.trustedProjects.length > 0) {
    process.stderr.write("auto-enrich: project config sets `trustedProjects`; ignored (trust must be granted from the global config)\n");
  }
  const { trustedProjects: _ignored, ...rest } = parsed;
  return rest;
}

/**
 * Merge a project config on top of the global config.
 *
 * Merge granularity is one level inside `providers.<name>`: a project
 * file that says `{ providers: { jira: { enabled: false } } }` does NOT
 * wipe out the global `cli` setting on the same provider; both keys
 * coexist with project values winning on overlap.
 *
 * Top-level non-`providers` keys from the project config also win, but
 * `trustedProjects` is intentionally absent (stripped by
 * `loadProjectConfig`) so this function cannot be tricked into honoring
 * project-granted trust.
 *
 * Either argument may be null/undefined - treat as `{}`.
 *
 * @param {AutoEnrichConfig|null|undefined} global
 * @param {AutoEnrichConfig|null|undefined} project
 * @returns {AutoEnrichConfig}
 */
export function mergeConfigs(global, project) {
  const g = global && typeof global === "object" ? global : {};
  const p = project && typeof project === "object" ? project : {};
  const merged = { ...g, ...p };

  const gProviders = g.providers && typeof g.providers === "object" ? g.providers : {};
  const pProviders = p.providers && typeof p.providers === "object" ? p.providers : {};
  const providerNames = new Set([...Object.keys(gProviders), ...Object.keys(pProviders)]);
  if (providerNames.size > 0) {
    const mergedProviders = {};
    for (const name of providerNames) {
      const gEntry = gProviders[name] && typeof gProviders[name] === "object" ? gProviders[name] : {};
      const pEntry = pProviders[name] && typeof pProviders[name] === "object" ? pProviders[name] : {};
      mergedProviders[name] = { ...gEntry, ...pEntry };
    }
    merged.providers = mergedProviders;
  }

  if (Array.isArray(g.trustedProjects)) {
    merged.trustedProjects = g.trustedProjects;
  }

  return merged;
}

/**
 * Convenience wrapper: load the global config, load the project config
 * (if any), and return the merged result. Use this everywhere a
 * provider-config decision is being made; use `loadConfig` directly
 * only when the caller specifically needs the global-only view (e.g.
 * `isProjectTrusted`, which must NEVER consult the project config).
 *
 * @param {string} cwd
 * @returns {Promise<{ global: AutoEnrichConfig, project: AutoEnrichConfig, effective: AutoEnrichConfig }>}
 */
export async function loadEffectiveConfig(cwd) {
  const [global, project] = await Promise.all([loadConfig(), loadProjectConfig(cwd)]);
  return { global, project, effective: mergeConfigs(global, project) };
}
