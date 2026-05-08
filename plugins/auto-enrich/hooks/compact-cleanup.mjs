#!/usr/bin/env node
import { safeJsonParse } from "./lib/json.mjs";
import { readCompactStash, stashForCompact } from "./lib/cache.mjs";

/**
 * Read all of stdin into a string. Claude Code pipes the hook payload here.
 *
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

/**
 * Render the post-compact reference list as markdown. Each line is just
 * the canonical id and short label, never the full enriched body, so the
 * agent has a pointer it can act on (re-mention to refetch, or query its
 * own tools) without re-bloating the conversation with everything that
 * was attached pre-compact.
 *
 * @param {import("./lib/cache.mjs").SeenItem[]} items
 * @returns {string}
 */
function formatReferences(items) {
  const lines = items.map((it) => `- \`${it.id}\` - ${it.summary}`);
  return [
    "### Previously auto-enriched references",
    "",
    "These items were attached to the conversation before it was compacted. The full content is no longer in context. If a follow-up needs one of them, mention it again to re-attach, or fetch it directly with the appropriate tool.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Hook entrypoint. Dispatches on `hook_event_name`:
 *
 *   - `PreCompact`:   move the session's seen-items list into the
 *                     post-compact stash and clear active dedup memory,
 *                     so the user can re-mention the same refs and have
 *                     them re-attached.
 *   - `SessionStart`: when `source === "compact"`, read the stash (without
 *                     clearing it) and emit a reference-only summary as
 *                     additionalContext so the model knows what was
 *                     previously attached. The stash stays in place so a
 *                     subsequent compaction can merge into it.
 *
 * Any uncaught error exits 0 so the hook never blocks Claude Code.
 */
async function main() {
  const input = safeJsonParse(await readStdin()) || {};
  const sessionId = input.session_id || "ephemeral";
  const event = input.hook_event_name;

  if (event === "PreCompact") {
    await stashForCompact(sessionId);
    return;
  }

  if (event === "SessionStart") {
    if (input.source !== "compact") return;
    const items = await readCompactStash(sessionId);
    if (!items.length) return;
    const additionalContext = formatReferences(items);
    process.stdout.write(
      JSON.stringify({
        continue: true,
        suppressOutput: false,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext,
        },
      }),
    );
  }
}

main().catch(() => process.exit(0));
