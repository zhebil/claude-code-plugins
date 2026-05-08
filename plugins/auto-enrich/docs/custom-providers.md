# Custom providers

This guide covers writing your own provider for `auto-enrich`: how
discovery works, the full interface contract, and runnable examples.

Built-in providers (GitHub, Jira, Sentry) are useful, but every team
has its own internal trackers, dashboards, or lookup CLIs. A custom
provider is a small ESM module that detects references in the user's
prompt and returns a markdown block. The plugin handles deduping,
budgeting, caching, and rendering.

## How discovery works

1. **At session start**, the plugin's `SessionStart` hook
   (`hooks/discover.mjs`) reads `~/.claude/auto-enrich/providers/`,
   scans for files matching `*.provider.mjs`, dynamic-imports each,
   and validates the export against the contract below.
2. Validated paths are written to `$CLAUDE_PLUGIN_DATA/discovery.json`
   (a manifest of absolute file paths plus a timestamp).
3. **On every `UserPromptSubmit`**, the orchestrator
   (`hooks/auto-enrich.mjs`) reads the manifest, dynamic-imports each
   listed module, re-checks the contract as defense-in-depth, and
   appends the resolved providers to the built-in array before the
   config filter runs.

Custom providers run **after** built-ins. To replace a built-in,
disable it via `config.json` and ship a custom one with a different
name (see [Replacing a built-in](#replacing-a-built-in)).

> **Note.** Discovery defaults to global only
> (`~/.claude/auto-enrich/...`). Project-level providers
> (`<projectRoot>/.claude/auto-enrich/...`) are also supported but are
> opt-in per project - see [Project-level providers](#project-level-providers)
> below. The opt-in mechanism prevents arbitrary cloned repositories
> from executing code inside the hook process.
>
> Adding, editing, or removing a provider file requires a new Claude
> Code session for the change to take effect (the manifest is written
> at session start, not re-scanned per prompt).

### Project-level providers

A project can ship its own providers under
`<projectRoot>/.claude/auto-enrich/providers/*.provider.mjs`, but the
plugin loads them only when the project's absolute path is on the
user's trust list in their **global** config:

```jsonc
// $CLAUDE_PLUGIN_DATA/config.json (or ~/.claude/auto-enrich.json)
{
  "trustedProjects": [
    "/Users/me/work/some-repo",
    "/Users/me/work/another-repo"
  ]
}
```

Match is exact against the resolved cwd Claude Code passes the hook -
no glob, no prefix walk. Trusting `/path/to/repo` does **not** trust
`/path/to/repo/sub`. If you need a subdirectory, list it explicitly.

`trustedProjects` is read **only** from the user's global config. An
in-repo `config.json` cannot grant itself trust; if it could, the
boundary would be useless.

Resolution order: built-ins win over global custom; global custom
wins over project custom. A project provider whose `name` collides
with anything earlier is rejected with a stderr warning.

The orchestrator re-checks the trust list at every prompt as defense
in depth, so revoking trust in the global config takes effect on the
next prompt without needing a SessionStart re-run.

**Why this matters.** Every `*.provider.mjs` is dynamic-imported into
the hook's Node process - the same process that has access to your
working tree, environment, and any tokens local CLIs (`gh`, `acli`,
`sentry`) can reach. A malicious provider could exfiltrate or modify
anything the hook can. The trust list keeps that surface to projects
you've consciously vouched for.

## File location and naming

- Global directory: `~/.claude/auto-enrich/providers/` (always scanned)
- Project directory: `<projectRoot>/.claude/auto-enrich/providers/`
  (scanned only when the cwd is on `trustedProjects` - see
  [Project-level providers](#project-level-providers))
- Filename: `<anything>.provider.mjs` (the suffix is required)
- Format: ECMAScript module (`type: "module"` semantics, no TypeScript
  toolchain - the hook runs raw `node`)
- Files in the directory that don't end in `.provider.mjs` are ignored
  silently.

## The provider contract

A provider is the default export (or named `provider` export) of the
module:

```js
export default {
  apiVersion: 1,
  name: "linear",

  // optional pre-flight, run before detect()
  async prepare(text, ctx) { /* ... */ },

  detect(text, codeRanges, ctx) {
    return [/* Match[] */];
  },

  async fetch(match, ctx) {
    return "#### markdown block" /* or null */;
  },

  summarize(match) {
    return "linear LIN-42";
  },
};
```

### Required fields

| Field         | Type        | Notes |
|---------------|-------------|-------|
| `apiVersion`  | `1`         | Forward-compat sentinel. Must be `1`. The plugin will reject other values without trying to load the module. |
| `name`        | `string`    | Stable id, non-empty. Doubles as the key under `ctx.state` and `config.providers`. Must NOT collide with any built-in (`github-issue`, `github-repo`, `jira`, `sentry`) or any earlier-loaded custom provider. |
| `detect`      | `function`  | Synchronous reference detector. See [`detect`](#detecttext-coderanges-ctx-match). |
| `fetch`       | `function`  | Async fetcher returning markdown or `null`. See [`fetch`](#fetchmatch-ctx-promisestringnull). |
| `summarize`   | `function`  | Pure label for the visible stderr line. See [`summarize`](#summarizematch-string). |

### Optional fields

| Field      | Type       | Notes |
|------------|------------|-------|
| `prepare`  | `function` | Async pre-flight, called once per prompt before `detect`. See [`prepare`](#preparetext-ctx-promisevoid). When present it MUST be a function. |

Any other keys you put on the object are ignored by the orchestrator
but kept on the object you write, so you can stash module-level helpers
or constants on it.

## Lifecycle (what happens per prompt)

```
            │  user submits prompt
            ▼
1. orchestrator loads config + manifest, builds providers array
            ▼
2. for every active provider:  await provider.prepare?.(text, ctx)   (parallel)
            ▼
3. for every active provider:  provider.detect(text, codeRanges, ctx) (sync, sequential)
            ▼
4. dedup by match.id, drop already-seen ids, cap to MAX_MATCHES_PER_PROMPT
            ▼
5. for each remaining match:   await provider.fetch(match, ctx)       (sequential, budgeted)
            ▼
6. emit stderr summary + JSON envelope with hookSpecificOutput.additionalContext
```

`detect` runs synchronously - if you need network or disk reads to
make detection decisions, do them in `prepare`.

## Method reference

### `prepare(text, ctx) => Promise<void>`

Optional. Runs once per prompt, before any provider's `detect`. All
providers' `prepare` calls run **in parallel**, so don't depend on
ordering between providers. Use it for one-shot async setup the
detector needs, like resolving the cwd's git remote or reading a
config file.

Stash results under `ctx.state[provider.name]`:

```js
async prepare(text, ctx) {
  // Cheap exit when the prompt clearly doesn't need this provider.
  if (!/\bLIN-\d+\b/.test(text)) return;
  const repo = await detectGitRemote(ctx);
  ctx.state[this.name] = { repo };
}
```

Errors thrown from `prepare` are swallowed by the orchestrator; the
provider's `detect` and `fetch` will still run. Treat exceptions as
"no scratch state" rather than "abort".

### `detect(text, codeRanges, ctx) => Match[]`

Synchronous. Returns an array of `Match` objects.

```js
/**
 * @typedef {Object} Match
 * @property {string} id   Stable, namespaced id - used for dedup and the
 *                         cross-session "seen" cache. Convention:
 *                         `${provider.name}:${stable-key}`.
 * Provider-specific fields may follow on the same object.
 */
```

The `id` is what the orchestrator uses to dedup matches and to skip
references already enriched in this session. It must be deterministic:
the same reference text MUST produce the same `id` every time, across
all providers. Namespace your ids with your provider's name to avoid
collisions with other providers.

`codeRanges` is a `[startInclusive, endExclusive][]` array of byte
ranges that fall inside inline backticks or fenced code blocks. **You
MUST skip matches whose offset falls inside any of these ranges**, so
that backticked text is never enriched.

```js
const insideCode = (offset, ranges) =>
  ranges.some(([start, end]) => offset >= start && offset < end);
```

Returning the same `id` twice is harmless - the orchestrator dedups
them. But returning a different `id` for the same logical reference
breaks dedup; be careful with case, whitespace, and protocol normalization.

### `fetch(match, ctx) => Promise<string|null>`

Async. Look up the reference and return a markdown block, or `null`
to skip silently.

```js
async fetch(match, ctx) {
  const { code, stdout } = await ctx.runner(
    "linear",
    ["issue", "get", match.key, "--json"],
    { cwd: ctx.cwd },
  );
  if (code !== 0) return null;
  const issue = JSON.parse(stdout);
  return [
    `#### Linear ${match.key}: ${issue.title}`,
    `- State: ${issue.state}`,
    `- Assignee: ${issue.assignee ?? "unassigned"}`,
    "",
    issue.description,
    "",
    `Refetch: \`linear issue get ${match.key}\``,
  ].join("\n");
}
```

Return `null` (not throw) for "expected" failures: CLI not installed,
auth missing, 404, parse error. The orchestrator swallows all
exceptions thrown from `fetch`, so throwing technically works the
same, but `null` is clearer intent.

Long-running paths can consult `ctx.budgetExceeded()` and bail early.

### `summarize(match) => string`

Pure. Returns a short human-readable label that appears in the
visible `Auto-enriched: <a>, <b>, <c>` line written to stderr.
Keep it under ~40 chars.

```js
summarize(match) {
  return `linear ${match.key}`;
}
```

## The `EnrichmentContext`

Same context every method (except `summarize`) receives:

| Field            | Type                                                           | Notes |
|------------------|----------------------------------------------------------------|-------|
| `cwd`            | `string`                                                       | Working directory passed by Claude Code. Use this for `runner` invocations. |
| `runner`         | `(cmd, args, options?) => Promise<{code, stdout, stderr}>`     | Subprocess runner. **Always use this, never `child_process` directly** so unit tests can inject a fake. `options.cwd` defaults to `ctx.cwd`. |
| `state`          | `Object<string, Object>`                                       | Per-provider scratch space. Read/write at `ctx.state[provider.name]` only. |
| `budgetExceeded` | `() => boolean`                                                | Returns `true` once the orchestrator's wall-clock budget (60 s default) is exhausted. |
| `providerConfig` | `(name: string) => Object`                                     | Returns the provider's user config sub-object, possibly empty. See [Reading user config](#reading-user-config). |

### Runner result shape

```ts
type CommandResult = {
  code:   number;   // exit code, 0 on success
  stdout: string;   // captured stdout
  stderr: string;   // captured stderr
};
```

The runner never throws on a non-zero exit; check `code !== 0`
yourself. It does throw on truly-broken invocations (binary not
found, etc.), but those are also caught upstream.

### Reading user config

Users configure the plugin via `$CLAUDE_PLUGIN_DATA/config.json` (or
`~/.claude/auto-enrich.json` fallback). Your provider can declare
opt-in keys under its name:

```jsonc
{
  "providers": {
    "linear": {
      "enabled": true,
      "team":    "BACKEND",
      "limit":   10
    }
  }
}
```

Read them in `prepare` or `fetch`:

```js
async fetch(match, ctx) {
  const cfg = ctx.providerConfig(this.name);
  const team = cfg.team ?? "default";
  // ...
}
```

`enabled` is consumed by the orchestrator before your provider is
called - if the user disabled you, none of your methods run. Anything
else is opaque to the plugin and yours to define.

## Validation rules

When a `*.provider.mjs` file is loaded, the plugin rejects it (with a
stderr warning) for any of these reasons:

- module fails to import (syntax error, missing dep, throws on load)
- no default export and no named `provider` export
- `apiVersion` is not `1`
- `name` is missing, not a string, or empty
- `name` collides with an existing provider (built-in or earlier custom)
- `detect`, `fetch`, or `summarize` is missing or not a function
- `prepare` is present but not a function

The orchestrator re-runs the contract checks at prompt time as
defense-in-depth, so a provider that passes discovery but is mutated
on disk afterwards will still be rejected before its code runs on a
match.

## Examples

### Minimal example

A provider that detects the literal word `hello` and injects `world`:

```js
// ~/.claude/auto-enrich/providers/hello.provider.mjs
const PATTERN = /\bhello\b/gi;

export default {
  apiVersion: 1,
  name: "hello",

  detect(text, codeRanges) {
    const insideCode = (offset) =>
      codeRanges.some(([s, e]) => offset >= s && offset < e);
    const out = [];
    const seen = new Set();
    for (const m of text.matchAll(PATTERN)) {
      if (insideCode(m.index)) continue;
      const id = `hello:${m.index}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id });
    }
    return out;
  },

  async fetch() {
    return "#### hello\nworld";
  },

  summarize() {
    return "hello -> world";
  },
};
```

### CLI-backed example with config

A Linear-issue provider that reads team and limit from config and
delegates to the `linear` CLI:

```js
const URL_PATTERN = /https?:\/\/linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/g;
const KEY_PATTERN = /(?<![\w-])([A-Z]+-\d+)(?![\w-])/g;

export default {
  apiVersion: 1,
  name: "linear",

  detect(text, codeRanges) {
    const insideCode = (offset) =>
      codeRanges.some(([s, e]) => offset >= s && offset < e);
    const matches = [];
    const seen = new Set();
    const push = (key, offset) => {
      if (insideCode(offset)) return;
      const id = `linear:${key}`;
      if (seen.has(id)) return;
      seen.add(id);
      matches.push({ id, key });
    };
    for (const m of text.matchAll(URL_PATTERN)) push(m[1], m.index);
    for (const m of text.matchAll(KEY_PATTERN)) push(m[1], m.index);
    return matches;
  },

  async fetch(match, ctx) {
    const cfg = ctx.providerConfig(this.name);
    const team = cfg.team ?? null;
    const args = ["issue", "get", match.key, "--json"];
    if (team) args.push("--team", team);

    const { code, stdout } = await ctx.runner("linear", args, { cwd: ctx.cwd });
    if (code !== 0) return null;
    let issue;
    try { issue = JSON.parse(stdout); } catch { return null; }

    const lines = [
      `#### Linear ${match.key}: ${issue.title}`,
      `- State: ${issue.state}`,
      `- Assignee: ${issue.assignee?.name ?? "unassigned"}`,
    ];
    if (issue.description) lines.push("", issue.description);
    lines.push("", `Refetch: \`linear issue get ${match.key}\``);
    return lines.join("\n");
  },

  summarize(match) {
    return `linear ${match.key}`;
  },
};
```

### Replacing a built-in

The orchestrator runs custom providers **after** built-ins, and
rejects names that collide. To override a built-in:

1. Disable the built-in via `config.json`:
   ```jsonc
   { "providers": { "jira": { "enabled": false } } }
   ```
2. Ship a custom provider with a **different** name (e.g. `my-jira`).
   It is free to detect Jira keys and call its own CLI; you control
   the markdown shape, the dedup key namespace, and the refetch hint.

You cannot register a custom provider under the same name as a
built-in. Discovery rejects collisions explicitly.

## Testing your provider

Validate the file at the CLI:

```bash
node --check ~/.claude/auto-enrich/providers/hello.provider.mjs
```

Run discovery + the prompt hook against a temp data dir to see what
Claude would receive without polluting your real session cache:

```bash
TMPDATA=$(mktemp -d)
CLAUDE_PLUGIN_DATA="$TMPDATA" node \
  ~/.claude/plugins/.../auto-enrich/hooks/discover.mjs

cat "$TMPDATA/discovery.json"

printf '%s' '{"session_id":"smoke","hook_event_name":"UserPromptSubmit","cwd":"'$PWD'","user_prompt":"hello there"}' \
  | CLAUDE_PLUGIN_DATA="$TMPDATA" node \
    ~/.claude/plugins/.../auto-enrich/hooks/auto-enrich.mjs

rm -rf "$TMPDATA"
```

(Replace `~/.claude/plugins/.../auto-enrich` with the actual install
path, or run from the marketplace clone.)

You can also write Node's built-in unit tests against your provider
the same way the built-ins do - see
`plugins/auto-enrich/test/unit/providers/*.test.mjs` for templates.

## Limitations

- **No TypeScript.** Files are loaded with raw `node`, so `.provider.ts`
  is not supported. Use `.provider.mjs` and JSDoc types.
- **No live reload.** Adding, editing, or removing a file requires a
  fresh Claude Code session for `SessionStart` to re-scan.
- **Project-level discovery is opt-in.** A repository's
  `.claude/auto-enrich/providers/` is loaded only when the project's
  absolute path appears in `trustedProjects` in the user's global
  config. Cloned repos cannot trust themselves. See
  [Project-level providers](#project-level-providers).
- **No bundled SDK.** The plugin's `lib/` helpers are not a public
  surface and may break between releases. Inline the small bits you
  need (the `insideCode` predicate is one line) rather than importing
  from inside the plugin.
- **No cross-session state.** The orchestrator's seen-id cache is
  shared across providers, but providers don't get a private cache.
  Stash session state under `ctx.state[provider.name]` (per-prompt
  only) and write to disk yourself if you need persistence.

## Reference: shipped types

JSDoc typedefs for the public contract live in
[`hooks/providers/index.mjs`](../hooks/providers/index.mjs):

- `Provider` - the contract above
- `Match`    - the shape `detect` returns
- `EnrichmentContext` - what `prepare`/`detect`/`fetch` receive
- `CommandResult` and `Runner` - the runner type

Validation logic and the `apiVersion` constant live in
[`hooks/lib/discovery.mjs`](../hooks/lib/discovery.mjs).
