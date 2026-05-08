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
