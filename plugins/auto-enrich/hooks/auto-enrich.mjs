#!/usr/bin/env node
import { runCommand } from "./lib/run.mjs";
import { safeJsonParse } from "./lib/json.mjs";
import { findCodeRanges } from "./lib/code-ranges.mjs";
import { loadSeenIds, saveSeenItems } from "./lib/cache.mjs";
import { loadConfig, isProviderEnabled, getProviderConfig } from "./lib/config.mjs";
import { loadCustomProviders } from "./lib/discovery.mjs";
import { providers } from "./providers/index.mjs";

const MAX_MATCHES_PER_PROMPT = 8;
const TOTAL_BUDGET_MS = 60_000;

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
  });
}

/**
 * Build the per-prompt enrichment context shared by every provider.
 *
 * @param {string} cwd Working directory passed by Claude Code.
 * @param {import("./lib/config.mjs").AutoEnrichConfig} config
 * @returns {import("./providers/index.mjs").EnrichmentContext}
 */
function buildContext(cwd, config) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  return {
    cwd,
    runner: runCommand,
    state: {},
    budgetExceeded: () => Date.now() >= deadline,
    providerConfig: (name) => getProviderConfig(config, name),
  };
}

/**
 * Run every active provider's `prepare()` lifecycle hook in parallel.
 * `prepare()` is optional and is responsible for stashing per-prompt
 * scratch state under `ctx.state[provider.name]` (e.g. github-issue
 * resolves the cwd's default repo here).
 *
 * @param {import("./providers/index.mjs").Provider[]} active
 * @param {string} text User prompt.
 * @param {import("./providers/index.mjs").EnrichmentContext} ctx
 * @returns {Promise<void>}
 */
async function prepareProviders(active, text, ctx) {
  await Promise.all(
    active.map(async (provider) => {
      if (typeof provider.prepare !== "function") return;
      try {
        await provider.prepare(text, ctx);
      } catch {
      }
    }),
  );
}

/**
 * Run every active provider's detector and return a flat,
 * dedup-by-id list of `{provider, match}` items in detection order.
 *
 * @param {import("./providers/index.mjs").Provider[]} active
 * @param {string} text
 * @param {[number, number][]} codeRanges
 * @param {import("./providers/index.mjs").EnrichmentContext} ctx
 * @returns {Array<{provider: import("./providers/index.mjs").Provider, match: import("./providers/index.mjs").Match}>}
 */
function detectMatchesAcrossProviders(active, text, codeRanges, ctx) {
  const collected = [];
  for (const provider of active) {
    for (const match of provider.detect(text, codeRanges, ctx)) {
      collected.push({ provider, match });
    }
  }
  const seenIds = new Set();
  const unique = [];
  for (const item of collected) {
    if (seenIds.has(item.match.id)) continue;
    seenIds.add(item.match.id);
    unique.push(item);
  }
  return unique;
}

/**
 * Sequentially fetch enrichment for each match. Per-match failures are
 * swallowed so one broken provider can't break the whole hook. Stops
 * early when the orchestrator's wall-clock budget is exhausted.
 *
 * @param {Array<{provider: import("./providers/index.mjs").Provider, match: import("./providers/index.mjs").Match}>} items
 * @param {import("./providers/index.mjs").EnrichmentContext} ctx
 * @returns {Promise<{blocks: string[], fetched: import("./lib/cache.mjs").SeenItem[]}>}
 */
async function fetchEnrichmentBlocks(items, ctx) {
  const blocks = [];
  const fetched = [];
  for (const { provider, match } of items) {
    if (ctx.budgetExceeded()) break;
    try {
      const block = await provider.fetch(match, ctx);
      if (!block) continue;
      blocks.push(block);
      fetched.push({ id: match.id, summary: provider.summarize(match) });
    } catch {
    }
  }
  return { blocks, fetched };
}

/**
 * Emit hook output in two channels:
 *   1. stderr - one-line human-visible summary the Claude Code TUI
 *      surfaces under the user's prompt.
 *   2. stdout - JSON envelope with `additionalContext` for Claude.
 *
 * Both `continue: true` and `suppressOutput: false` are required for
 * `systemMessage` rendering on some Claude Code builds (see anthropics/claude-code#50542).
 *
 * @param {{blocks: string[], summaries: string[]}} result
 */
function emitHookOutput({ blocks, summaries }) {
  const additionalContext = `### Auto-enriched context\n\n${blocks.join("\n\n")}`;
  const systemMessage = `Auto-enriched: ${summaries.join(", ")}`;
  process.stderr.write(`${systemMessage}\n`);
  process.stdout.write(
    JSON.stringify({
      continue: true,
      suppressOutput: false,
      systemMessage,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    }),
  );
}

/**
 * Hook entrypoint. Steps:
 *   1. Parse the Claude Code stdin payload.
 *   2. Compute code-span ranges so backticked refs are excluded.
 *   3. Run every provider's `prepare()` (parallel).
 *   4. Detect references via every provider, dedup.
 *   5. Drop ids already enriched in this session.
 *   6. Cap to MAX_MATCHES_PER_PROMPT (after seen-filter so we never
 *      starve fresh refs).
 *   7. Fetch fresh blocks (respecting wall-clock budget), persist new
 *      ids, emit output.
 *
 * Any uncaught error exits 0 so we never block the user's prompt.
 */
async function main() {
  const input = safeJsonParse(await readStdin()) || {};
  const userPrompt = input.user_prompt || input.prompt || "";
  if (!userPrompt.trim()) return;

  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || "ephemeral";
  const codeRanges = findCodeRanges(userPrompt);
  const config = await loadConfig();
  const builtinNames = new Set(providers.map((p) => p.name));
  const custom = await loadCustomProviders(builtinNames);
  const allProviders = [...providers, ...custom];
  const active = allProviders.filter((p) => isProviderEnabled(config, p.name));
  if (!active.length) return;
  const ctx = buildContext(cwd, config);

  await prepareProviders(active, userPrompt, ctx);

  const detected = detectMatchesAcrossProviders(active, userPrompt, codeRanges, ctx);
  if (!detected.length) return;

  const { all, seen } = await loadSeenIds(sessionId);
  const fresh = detected
    .filter(({ match }) => !seen.has(match.id))
    .slice(0, MAX_MATCHES_PER_PROMPT);
  if (!fresh.length) return;

  const { blocks, fetched } = await fetchEnrichmentBlocks(fresh, ctx);
  if (!blocks.length) return;

  const existing = Array.isArray(all.sessions[sessionId]) ? all.sessions[sessionId] : [];
  await saveSeenItems(all, sessionId, [...existing, ...fetched]);
  emitHookOutput({ blocks, summaries: fetched.map((it) => it.summary) });
}

main().catch(() => process.exit(0));
