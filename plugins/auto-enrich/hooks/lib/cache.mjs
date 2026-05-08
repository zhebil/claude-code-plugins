import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeJsonParse } from "./json.mjs";

const MAX_SESSION_ENTRIES = 200;

/**
 * @typedef {Object} SeenSnapshot
 * @property {Object<string, string[]>} allSessions Whole on-disk map keyed by
 *   session id, used so callers can persist updates without losing other
 *   sessions' state.
 * @property {Set<string>} seen Match ids already enriched in this session.
 */

/**
 * Resolve the cache file path. Honors `CLAUDE_PLUGIN_DATA` if set (Claude
 * Code's per-plugin data dir); otherwise falls back to `~/.cache/claude-auto-enrich`.
 *
 * @returns {string} Absolute path to the JSON cache file.
 */
function getCachePath() {
  const base = process.env.CLAUDE_PLUGIN_DATA
    || join(process.env.HOME || process.cwd(), ".cache", "claude-auto-enrich");
  return join(base, "seen.json");
}

/**
 * Load the set of already-enriched match ids for a session. Returns an
 * empty snapshot when:
 *   - the cache file does not exist yet (first run), or
 *   - its contents are not valid JSON (corrupted - we'll overwrite).
 *
 * Other errors (EACCES, EISDIR, etc.) are written to stderr so they
 * surface in the hook log rather than silently disabling dedup. We still
 * return an empty snapshot so the prompt isn't blocked.
 *
 * @param {string} sessionId Claude Code session id (or `"ephemeral"`).
 * @returns {Promise<SeenSnapshot>}
 */
export async function loadSeenIds(sessionId) {
  let raw;
  try {
    raw = await readFile(getCachePath(), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(`auto-enrich: cache read failed (${error?.code ?? error}); continuing without dedup\n`);
    }
    return { allSessions: {}, seen: new Set() };
  }
  const data = safeJsonParse(raw) || {};
  const seen = new Set(Array.isArray(data[sessionId]) ? data[sessionId] : []);
  return { allSessions: data, seen };
}

/**
 * Persist updated seen-ids for a session via atomic write (`tmp → rename`).
 * Caps each session's list to `MAX_SESSION_ENTRIES` newest entries to keep
 * the cache file bounded.
 *
 * @param {Object<string, string[]>} allSessions The full cache map (caller
 *   should pass the value returned by {@link loadSeenIds}).
 * @param {string} sessionId Session id to update.
 * @param {Set<string>} seen Updated set of ids for that session.
 * @returns {Promise<void>}
 */
export async function saveSeenIds(allSessions, sessionId, seen) {
  const file = getCachePath();
  allSessions[sessionId] = [...seen].slice(-MAX_SESSION_ENTRIES);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(allSessions, null, 2));
  await rename(tmp, file);
}
