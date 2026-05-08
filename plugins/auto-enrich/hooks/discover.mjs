#!/usr/bin/env node
import { discoverProviders, writeManifest } from "./lib/discovery.mjs";
import { providers } from "./providers/index.mjs";

/**
 * SessionStart hook entrypoint. Scans `~/.claude/auto-enrich/providers/`
 * for `*.provider.mjs` files, validates each against the contract, and
 * writes the resolved list to `$CLAUDE_PLUGIN_DATA/discovery.json` so
 * UserPromptSubmit can dynamic-import them without re-validating.
 *
 * Any error exits 0 so a broken custom provider never blocks the
 * session from starting.
 */
async function main() {
  const builtinNames = new Set(providers.map((p) => p.name));
  const { paths, warnings } = await discoverProviders({ builtinNames });
  for (const warning of warnings) process.stderr.write(`${warning}\n`);
  await writeManifest(paths);
  if (paths.length) {
    process.stderr.write(`auto-enrich: loaded ${paths.length} custom provider(s)\n`);
  }
}

main().catch(() => process.exit(0));
