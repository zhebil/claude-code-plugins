---
name: configure-auto-enrich
description: Set up and configure the auto-enrich plugin - verify CLIs, pick the Jira backend, write config.json, smoke test the hook, and (optionally) scaffold a custom provider. Use ONLY when the user explicitly invokes this skill via `/auto-enrich:configure-auto-enrich` or asks to set up / configure / troubleshoot auto-enrich. Do NOT auto-trigger from generic mentions of GitHub, Jira, Sentry, or "context enrichment".
user-invocable: true
disable-model-invocation: true
---

# auto-enrich: setup & configuration

Guided walkthrough for setting up auto-enrich. Briefly explains the plugin, verifies CLIs, writes a config file, smoke-tests the hook, and optionally helps the user write a custom provider.

> User-invoked only. Don't run this skill as a side effect of unrelated work. If the user mentions Jira / GitHub / Sentry without asking to configure auto-enrich, ignore this skill.

## What auto-enrich is (60 seconds)

When the user submits a prompt mentioning a Jira ticket, GitHub PR/issue/repo, or Sentry issue, auto-enrich runs **before Claude reads the prompt** and prepends a compact markdown summary fetched via local CLIs (`gh`, `acli`/`jira`, `sentry`).

- No AI calls.
- No stored credentials - it reuses the user's existing CLI auth.
- Refs inside backticks or fenced code blocks are skipped.
- Each ref is enriched once per session (dedup cache at `$CLAUDE_PLUGIN_DATA/seen.json`, preserved across `/compact`).

## How it works (high level)

The plugin registers three hooks in `hooks/hooks.json`:

- **`UserPromptSubmit`** -> `hooks/auto-enrich.mjs`. The main hook. Each provider's `detect()` finds refs; `fetch()` shells out to its CLI; the orchestrator dedupes, drops already-seen ids, caps to a per-prompt max, and emits a JSON envelope on stdout plus an `Auto-enriched: ...` line on stderr.
- **`SessionStart`** -> `hooks/discover.mjs`. Scans `~/.claude/auto-enrich/providers/` (and any trusted project dirs) for custom `*.provider.mjs` files, validates them, writes `discovery.json`. **Manifest is built once per session** - editing a provider mid-session has no effect until the next new session.
- **`SessionStart` (matcher: `compact`)** and **`PreCompact`** -> `hooks/compact-cleanup.mjs`. Stash and re-surface seen-ids around `/compact` so dedup state survives compaction without starving fresh refs.

Built-in providers: `github-issue`, `github-repo`, `jira`, `sentry`. Each can be disabled, and the Jira provider can run on either `acli` or `jira-cli`.

## Walkthrough

Run these in order. Don't skip ahead - each step depends on the previous one's answers.

### Step 1 - which sources does the user want enriched?

Ask, before doing anything else:

> Which sources do you want auto-enrich to pull context for?
> 1. **GitHub** (PRs, issues, repos, READMEs)
> 2. **Jira** tickets
> 3. **Sentry** issues
>
> Pick any combination. Also: do you want me to walk you through writing a custom provider afterwards (e.g. for Linear, Shortcut, internal trackers)?

Use the answers to drive every subsequent step. Skip checks for sources the user didn't pick.

### Step 2 - verify CLIs are installed and authenticated

For each chosen source, run BOTH the install check and the auth check, and report results back. Don't proceed past a broken CLI - either help fix it or explicitly disable that provider in step 4.

| Source | Install check | Auth check |
|---|---|---|
| GitHub | `command -v gh` | `gh auth status` |
| Jira (acli) | `command -v acli` | `acli jira workitem search --jql 'assignee = currentUser()' --limit 1` |
| Jira (jira-cli) | `command -v jira` | `jira me` |
| Sentry | `command -v sentry` | `sentry org list --json` (any non-empty array means authed) |

For Jira, run BOTH install checks - the user might already have one and not know which the plugin supports. Use that to inform step 3.

If a CLI is missing, point at the install. **Don't run the install yourself** - it's a system-wide change and these usually want sudo or a Homebrew prompt:

- `gh`: `brew install gh` (macOS) or https://cli.github.com/
- `acli`: https://developer.atlassian.com/cloud/acli/getting-started/
- `jira-cli`: `brew install ankitpokhrel/jira-cli/jira-cli`
- `sentry`: install via `brew install getsentry/tools/sentry` or `curl https://cli.sentry.dev/install -fsS | bash`. Docs: https://cli.sentry.dev/. The binary is `sentry` (NOT `sentry-cli`) - confirm with `command -v sentry`. Note: an older legacy Homebrew formula and binary called `sentry-cli` exists for source-map uploads / release tooling; that is a different tool and the plugin does not use it.

If auth is missing, suggest the right command and let the user run it themselves (these are interactive):

- `gh auth login`
- `acli jira auth login`
- `jira init`
- `sentry auth login`

After the user reports auth succeeded, re-run the auth check to confirm.

### Step 3 - choose the Jira CLI (only if Jira is enabled)

Ask:

> Auto-enrich's `jira` provider supports two CLIs:
>
> - **`acli`** (default) - Atlassian's official CLI. Heavier, but actively maintained and authenticates against Atlassian Cloud out of the box.
> - **`jira-cli`** (ankitpokhrel/jira-cli, binary name `jira`) - lighter, third-party, popular among power users.
>
> Which do you want? If you're unsure, or already authed to one of them, pick the one that's working - the markdown output is identical either way.

Default to `acli` if no preference. Record the choice for step 4.

### Step 4 - write `config.json`

Resolve the path:

```bash
echo "${CLAUDE_PLUGIN_DATA:-$HOME/.claude}/config.json"
```

- Inside Claude Code, `CLAUDE_PLUGIN_DATA` is set per-plugin and that's the canonical location.
- Outside Claude Code (or when the env var isn't set), the fallback is `~/.claude/auto-enrich.json`.
- If you're running this skill from a Claude Code session, prefer the env-var path - it's what the running hook reads.

If the file already exists, **show the user its current state first** so they have a baseline before deciding what to change.

Schema:

```jsonc
{
  "providers": {
    "github-issue": { "enabled": true },
    "github-repo":  { "enabled": true },
    "jira":         { "enabled": true, "cli": "acli" },
    "sentry":       { "enabled": true }
  },
  "trustedProjects": []
}
```

Key reference:

| Key | Type | Default | Effect |
|---|---|---|---|
| `providers.<name>.enabled` | boolean | `true` | When `false`, that provider's `prepare`/`detect`/`fetch` are not run. Built-in names: `github-issue`, `github-repo`, `jira`, `sentry`. |
| `providers.jira.cli` | `"acli" \| "jira-cli"` | `"acli"` | Backend CLI for Jira. Unknown values fall back to `acli`. |
| `trustedProjects` | `string[]` | `[]` | Absolute project-root paths whose `<cwd>/.claude/auto-enrich/providers/*.provider.mjs` files are loaded. **Security-sensitive** - see step 6. |

A missing or invalid file means defaults (every provider on, `acli` for jira, no trusted projects). If the user wants pure defaults, **offer to delete the config file** rather than write one - less is more.

For everything else: build the JSON from the user's choices, **show the diff** (current vs proposed), and only write after explicit confirmation. After writing, `cat` the file back so the user can verify. Use `mkdir -p` for the parent dir if it's missing.

Only write `{ "enabled": false }` for providers the user explicitly wants OFF. Providers they want ON can be left out of the file entirely.

### Step 5 - smoke test the hook

Pick a real reference the user is OK fetching (a PR they own, a Jira ticket they have access to, etc.). Then run the hook directly with a temp data dir so the seen-cache is bypassed:

```bash
printf '%s' '{"session_id":"smoke","hook_event_name":"UserPromptSubmit","cwd":"'$PWD'","user_prompt":"<USER REF HERE>"}' \
  | CLAUDE_PLUGIN_DATA="$(mktemp -d)" node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/cache/zhebil-tools/plugins/auto-enrich}/hooks/auto-enrich.mjs"
```

`CLAUDE_PLUGIN_ROOT` is set inside Claude Code; outside, point it at the marketplace install. The `mktemp -d` for `CLAUDE_PLUGIN_DATA` means the same ref will enrich on every re-run - in normal use the cache prevents that within a session.

Look for two signals:

1. **stderr** has a single line like `Auto-enriched: github PR anthropics/claude-code#123`.
2. **stdout** is JSON whose `hookSpecificOutput.additionalContext` is a non-empty markdown block (wrapped in `<external_content source="...">` tags).

If both are there, it works. If something's off:

- Re-run the auth check from step 2 - tokens expire.
- `cat "$CLAUDE_PLUGIN_DATA/config.json"` - is the provider disabled?
- Was the ref inside backticks? Strip them.
- For Jira, does `config.json`'s `cli` value match an installed and authed CLI?
- Check stderr for lines starting `auto-enrich:` - those are validation/runtime warnings.

### Step 6 - (optional) custom providers

If the user said yes to step 1's custom-provider question:

1. Read `custom-provider-example.mjs` next to this SKILL.md and walk them through it. The file is a runnable, well-commented Linear-issue provider that demonstrates every part of the contract (`apiVersion`, `name`, `prepare`, `detect`, `fetch`, `summarize`, config reading, error handling, code-range filtering).
2. Have them copy it to `~/.claude/auto-enrich/providers/<name>.provider.mjs`. The `.provider.mjs` suffix is required - other files in that directory are ignored silently.
3. Tell them to **start a new Claude Code session** for it to take effect. "New session" means `/exit` then `claude` again, or quitting the terminal window. **`/reload-plugins` does NOT re-run `SessionStart`**, so it won't pick up new or edited provider files.
4. After restart, `cat $CLAUDE_PLUGIN_DATA/discovery.json` to confirm the new provider was validated and listed (with `source: "global"`). Then re-run the smoke command from step 5 with a ref the new provider should match.

For the full contract (validation rules, lifecycle, EnrichmentContext fields, replacing a built-in), point at `plugins/auto-enrich/docs/custom-providers.md`. The example file in this skill is a starter; the docs are the spec.

#### Project-level providers (advanced, security-sensitive)

If the user has a project that needs its own providers (e.g. an internal tracker only this codebase uses), explain the trust model **before** they opt in:

> Adding a path to `trustedProjects` grants that repository execute-on-session-start privileges. Every `*.provider.mjs` checked into `<repo>/.claude/auto-enrich/providers/` - including any added by future commits or merged PRs - will be `import()`-ed in the hook's Node process, with access to your working tree, env, and any tokens `gh` / `acli` / `sentry` can reach. **Trust only repos whose contributor list is fully under your control.**

If the user still wants it, add to the **global** config (`$CLAUDE_PLUGIN_DATA/config.json` or `~/.claude/auto-enrich.json`):

```jsonc
{
  "trustedProjects": ["/Users/<me>/work/<repo>"]
}
```

Things to flag:

- **Match is exact** against the resolved cwd - no glob, no prefix walk. Trusting `/path/to/repo` does NOT trust `/path/to/repo/sub`. List subdirs explicitly if needed.
- **Trust is read only from the global config.** An in-repo `config.json` cannot grant itself trust.
- **Resolution order**: built-ins win over global custom; global custom wins over project custom. A project provider whose `name` collides with anything earlier is rejected with a stderr warning.
- The orchestrator re-checks the trust list at every prompt, so revoking trust takes effect on the next prompt without needing a fresh session.

Project providers go in `<projectRoot>/.claude/auto-enrich/providers/*.provider.mjs`. Same contract, same `.provider.mjs` suffix.

## Notes for future invocations

- This skill is idempotent - the user can re-run it any time to change settings. No harm in re-running just step 4.
- Don't edit `settings.json`, `hooks.json`, or any plugin source code from this skill. Scope is: install/auth checks, `auto-enrich`'s own config file, and (optionally) dropping a provider file under `~/.claude/auto-enrich/providers/` or a trusted project's `.claude/auto-enrich/providers/`.
- For ad-hoc debugging: `cat $CLAUDE_PLUGIN_DATA/discovery.json` (which custom providers loaded), `cat $CLAUDE_PLUGIN_DATA/seen.json` (per-session dedup cache + post-compact stash), and stderr `auto-enrich:` lines (validation/runtime warnings).
