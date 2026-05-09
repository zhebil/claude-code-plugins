// Example custom provider for auto-enrich.
//
// What this does: detects Linear issue references in the user's prompt
// (URLs like `https://linear.app/myteam/issue/LIN-42` and bare keys like
// `LIN-42`) and injects a markdown summary fetched via the `linear` CLI.
//
// To use:
//   1. Copy this file to one of:
//        - ~/.claude/auto-enrich/providers/linear.provider.mjs        (always loaded)
//        - <projectRoot>/.claude/auto-enrich/providers/linear.provider.mjs
//          (loaded only when <projectRoot> is on `trustedProjects`)
//      The `.provider.mjs` suffix is required - other filenames are ignored.
//   2. Start a NEW Claude Code session (`/exit` then `claude`). `/reload-plugins`
//      does not re-run the SessionStart discovery hook, so a fresh session is
//      necessary for the manifest to pick this file up.
//   3. (Optional) Add user config under the provider's `name`:
//        // $CLAUDE_PLUGIN_DATA/config.json
//        { "providers": { "linear": { "enabled": true, "team": "BACKEND" } } }
//   4. Verify load: `cat $CLAUDE_PLUGIN_DATA/discovery.json` should list this file.
//
// The full contract reference lives in:
//   plugins/auto-enrich/docs/custom-providers.md
//
// This file is annotated to explain *why* each piece exists - feel free to
// strip the comments when you adapt it.

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------
//
// Linear keys look like `LIN-42`, `BACKEND-1234`, etc. We match both:
//   - the full URL form (most reliable, gives us the team prefix in path too)
//   - the bare key form, with lookarounds so we don't match inside words like
//     "BIN-42" embedded in `XBIN-42` or "FOO-1" inside a hash.

const URL_PATTERN = /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]+-\d+)/g;
const KEY_PATTERN = /(?<![\w-])([A-Z][A-Z0-9]+-\d+)(?![\w-])/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
//
// `codeRanges` is a [[startInclusive, endExclusive], ...] list of byte ranges
// inside backticks or fenced code blocks. ANY match whose offset falls in one
// of these ranges MUST be skipped - that's how the plugin guarantees that
// backticked text is never enriched. Inline this small predicate rather than
// importing from the plugin's lib/ - lib/ is not a stable public API.

const isInsideCode = (offset, ranges) =>
  ranges.some(([start, end]) => offset >= start && offset < end);

// ---------------------------------------------------------------------------
// The provider object
// ---------------------------------------------------------------------------
//
// Required fields: apiVersion, name, detect, fetch, summarize.
// Optional:        prepare.
// Anything else is yours to use as module-level helpers.

export default {
  // Forward-compat sentinel. Must be the literal `1`. Future contract changes
  // will introduce new versions; the plugin will continue supporting v1.
  apiVersion: 1,

  // Stable id. Doubles as the key under `ctx.state` (per-prompt scratch space)
  // and `config.providers` (user config). Must NOT collide with any built-in
  // (`github-issue`, `github-file`, `github-repo`, `jira`, `sentry`) or any earlier-loaded
  // custom provider.
  name: "linear",

  // -------------------------------------------------------------------------
  // prepare(text, ctx) - optional async pre-flight, runs once per prompt.
  //
  // Use it for one-shot async setup that detect() needs (e.g. resolving the
  // cwd's git remote, reading a config file, hitting a `linear teams` API).
  // All providers' `prepare` calls run in parallel, so don't depend on
  // ordering across providers.
  //
  // Stash results under `ctx.state[this.name]` - never on `ctx` itself.
  //
  // Errors thrown here are swallowed - treat them as "no scratch state",
  // not "abort". detect() and fetch() will still run.
  //
  // For Linear we don't need anything async upfront, so this is a no-op
  // example. If your detection requires the cwd's git remote (the way
  // github-issue's prepare does), this is where it'd go.
  // -------------------------------------------------------------------------
  async prepare(text, ctx) {
    // Cheap exit when the prompt clearly doesn't reference us. Saves work for
    // every other prompt that has nothing to do with Linear.
    if (!URL_PATTERN.test(text) && !KEY_PATTERN.test(text)) return;

    // Reset the lastIndex side-effect that the .test() above left behind.
    URL_PATTERN.lastIndex = 0;
    KEY_PATTERN.lastIndex = 0;

    // Real work would go here. Example skeleton:
    //   const cfg = ctx.providerConfig(this.name);
    //   ctx.state[this.name] = { team: cfg.team ?? null };
  },

  // -------------------------------------------------------------------------
  // detect(text, codeRanges, ctx) - SYNCHRONOUS, returns an array of Match.
  //
  // A Match is `{ id, ...whatever fetch needs }`. The `id` is what the
  // orchestrator uses for dedup AND for the cross-session "seen" cache,
  // so it must be deterministic - the same reference text must always
  // produce the same id. Convention: namespace it as `${this.name}:${key}`.
  //
  // Returning the same id twice is harmless; the orchestrator dedups them.
  // Returning a *different* id for the same logical reference breaks dedup.
  // -------------------------------------------------------------------------
  detect(text, codeRanges, ctx) {
    const matches = [];
    const seen = new Set();

    const push = (key, offset) => {
      // Skip refs inside backticks / fenced code blocks. This is mandatory.
      if (isInsideCode(offset, codeRanges)) return;
      const id = `linear:${key}`;
      // Local dedup so URL + bare-key for the same issue don't both push.
      if (seen.has(id)) return;
      seen.add(id);
      matches.push({ id, key });
    };

    for (const m of text.matchAll(URL_PATTERN)) push(m[1], m.index);
    for (const m of text.matchAll(KEY_PATTERN)) push(m[1], m.index);

    return matches;
  },

  // -------------------------------------------------------------------------
  // fetch(match, ctx) - async, returns a markdown string or null.
  //
  // ALWAYS use `ctx.runner` (not `child_process` directly). The runner is
  // injected so unit tests can stub CLI calls; reaching for `child_process`
  // bypasses that.
  //
  // Return `null` (don't throw) for "expected" failures: CLI not installed,
  // auth missing, 404, parse error. Exceptions are swallowed by the
  // orchestrator anyway, but null is clearer intent.
  //
  // Long-running paths can poll `ctx.budgetExceeded()` and bail out.
  // -------------------------------------------------------------------------
  async fetch(match, ctx) {
    const cfg = ctx.providerConfig(this.name); // always returns an object
    const args = ["issue", "get", match.key, "--json"];
    if (cfg.team) args.push("--team", cfg.team);

    const { code, stdout } = await ctx.runner("linear", args, { cwd: ctx.cwd });
    if (code !== 0) return null;

    let issue;
    try {
      issue = JSON.parse(stdout);
    } catch {
      return null;
    }

    const lines = [
      `#### Linear ${match.key}: ${issue.title ?? "(untitled)"}`,
      `- State: ${issue.state ?? "unknown"}`,
      `- Assignee: ${issue.assignee?.name ?? "unassigned"}`,
    ];
    if (issue.description) {
      lines.push("", issue.description);
    }
    lines.push("", `Refetch: \`linear issue get ${match.key}\``);
    return lines.join("\n");
  },

  // -------------------------------------------------------------------------
  // summarize(match) - PURE. Returns the short label for the visible
  // `Auto-enriched: <a>, <b>, <c>` line on stderr. Keep it under ~40 chars.
  // -------------------------------------------------------------------------
  summarize(match) {
    return `linear ${match.key}`;
  },
};
