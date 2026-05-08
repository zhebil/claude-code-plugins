import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeJsonParse } from "./json.mjs";

const MAX_SESSION_ENTRIES = 200;

/**
 * @typedef {Object} SeenItem
 * @property {string} id      Stable, namespaced id (matches `Match.id`).
 * @property {string} summary Short human label (matches `provider.summarize(match)`).
 */

/**
 * @typedef {Object} CacheFile
 * @property {Object<string, SeenItem[]>} sessions Active per-session enrichment
 *   memory, used for dedup so we don't re-fetch the same ref twice.
 * @property {Object<string, SeenItem[]>} stashed Per-session list of items that
 *   were enriched in the conversation that just got compacted. Populated by
 *   the PreCompact hook, drained by SessionStart-on-compact so the model
 *   sees a list of "you previously attached these" references after compact.
 */

/**
 * @typedef {Object} SeenSnapshot
 * @property {CacheFile} all Whole on-disk cache, used so callers can persist
 *   updates without losing other sessions' or other keys' state.
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
 * Read the raw cache file. Returns an empty `CacheFile` when the file is
 * absent or unparseable.
 *
 * @returns {Promise<CacheFile>}
 */
async function readCache() {
  let raw;
  try {
    raw = await readFile(getCachePath(), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(`auto-enrich: cache read failed (${error?.code ?? error})\n`);
    }
    return { sessions: {}, stashed: {} };
  }
  const data = safeJsonParse(raw) || {};
  return {
    sessions: data.sessions && typeof data.sessions === "object" ? data.sessions : {},
    stashed: data.stashed && typeof data.stashed === "object" ? data.stashed : {},
  };
}

/**
 * Atomically write the cache file (`tmp → rename`). Caller is responsible
 * for capping any list sizes before passing the object in.
 *
 * @param {CacheFile} all
 * @returns {Promise<void>}
 */
async function writeCache(all) {
  const file = getCachePath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(all, null, 2));
  await rename(tmp, file);
}

/**
 * Load the set of already-enriched match ids for a session. Other errors
 * (EACCES, EISDIR, etc.) are written to stderr so they surface in the hook
 * log rather than silently disabling dedup. We still return an empty
 * snapshot so the prompt isn't blocked.
 *
 * @param {string} sessionId Claude Code session id (or `"ephemeral"`).
 * @returns {Promise<SeenSnapshot>}
 */
export async function loadSeenIds(sessionId) {
  const all = await readCache();
  const items = Array.isArray(all.sessions[sessionId]) ? all.sessions[sessionId] : [];
  const seen = new Set(items.map((it) => it?.id).filter((id) => typeof id === "string"));
  return { all, seen };
}

/**
 * Persist updated seen items for a session. Caps each session's list to
 * `MAX_SESSION_ENTRIES` newest entries to keep the cache file bounded.
 *
 * @param {CacheFile} all The full cache object (caller should pass the value
 *   returned by {@link loadSeenIds}).
 * @param {string} sessionId Session id to update.
 * @param {SeenItem[]} items Updated list of items for that session.
 * @returns {Promise<void>}
 */
export async function saveSeenItems(all, sessionId, items) {
  all.sessions[sessionId] = items.slice(-MAX_SESSION_ENTRIES);
  await writeCache(all);
}

/**
 * Merge a session's seen-items into the post-compact stash and clear the
 * active session entry, in a single atomic write. Called from PreCompact:
 * the model is about to lose the inline enrichment context, so we save a
 * lightweight reference list to be re-emitted after compact, and we clear
 * dedup memory so the user can re-mention the same refs and have them
 * re-attached.
 *
 * The stash is sticky across compactions within a session: existing stashed
 * items are preserved and deduped against the current session items (current
 * wins on id collision so summaries reflect the latest enrichment). This is
 * what lets a session that has been compacted multiple times still surface
 * refs from the very first turn.
 *
 * No-op when both the session entry and the existing stash are empty.
 *
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function stashForCompact(sessionId) {
  const all = await readCache();
  const items = Array.isArray(all.sessions[sessionId]) ? all.sessions[sessionId] : [];
  const prior = Array.isArray(all.stashed[sessionId]) ? all.stashed[sessionId] : [];
  if (!items.length && !prior.length) return;
  const byId = new Map();
  for (const it of prior) if (it && typeof it.id === "string") byId.set(it.id, it);
  for (const it of items) if (it && typeof it.id === "string") byId.set(it.id, it);
  all.stashed[sessionId] = Array.from(byId.values()).slice(-MAX_SESSION_ENTRIES);
  delete all.sessions[sessionId];
  await writeCache(all);
}

/**
 * Read the post-compact stash for a session without clearing it. Called
 * from SessionStart-on-compact to surface "previously attached" references.
 *
 * The stash is intentionally NOT drained here: a session can be compacted
 * more than once, and each subsequent PreCompact merges fresh items into
 * the same stash. Draining on read would lose refs from earlier compactions.
 *
 * @param {string} sessionId
 * @returns {Promise<SeenItem[]>} Empty array when nothing was stashed.
 */
export async function readCompactStash(sessionId) {
  const all = await readCache();
  const items = Array.isArray(all.stashed[sessionId]) ? all.stashed[sessionId] : [];
  return items;
}
