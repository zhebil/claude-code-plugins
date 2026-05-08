#!/usr/bin/env node
import { discoverProviders, getProjectDiscoveryDir, writeManifest } from "./lib/discovery.mjs";
import { isProjectTrusted, loadConfig } from "./lib/config.mjs";
import { safeJsonParse } from "./lib/json.mjs";
import { providers } from "./providers/index.mjs";

/**
 * Best-effort read of stdin without blocking forever. SessionStart
 * payloads from Claude Code carry `cwd`, but the hook may also be
 * invoked manually with no stdin - in that case we fall back to
 * `process.cwd()` after a short timeout.
 *
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
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
 * SessionStart hook entrypoint. Scans the global discovery directory
 * (`~/.claude/auto-enrich/providers/`) plus, when the cwd is on the
 * user's trust list, the project directory
 * (`<cwd>/.claude/auto-enrich/providers/`). Validated entries are
 * written to `$CLAUDE_PLUGIN_DATA/discovery.json` so UserPromptSubmit
 * can dynamic-import them without re-validating.
 *
 * Trust is read from the GLOBAL config only; an in-repo file cannot
 * grant itself trust.
 *
 * Any error exits 0 so a broken custom provider never blocks the
 * session from starting.
 */
async function main() {
  const input = safeJsonParse(await readStdin()) || {};
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const config = await loadConfig();
  const trusted = isProjectTrusted(config, cwd);
  const projectDir = trusted ? getProjectDiscoveryDir(cwd) : null;

  const builtinNames = new Set(providers.map((p) => p.name));
  const { entries, warnings } = await discoverProviders({ builtinNames, projectDir });
  for (const warning of warnings) process.stderr.write(`${warning}\n`);
  await writeManifest(entries);

  if (entries.length) {
    const counts = entries.reduce(
      (acc, e) => ({ ...acc, [e.source]: (acc[e.source] || 0) + 1 }),
      {},
    );
    const parts = [];
    if (counts.global) parts.push(`${counts.global} global`);
    if (counts.project) parts.push(`${counts.project} project`);
    process.stderr.write(`auto-enrich: loaded ${entries.length} custom provider(s) (${parts.join(", ")})\n`);
  }
}

main().catch(() => process.exit(0));
