# auto-enrich

Claude Code plugin that enriches submitted prompts with compact context for referenced work items.

## What it detects

- Jira URLs and bare keys like `ABC-123`
- GitHub PR/issue URLs, `owner/repo#123`, and bare `#123` in a GitHub repo
- GitHub repository URLs, including README content
- Sentry issue URLs

Matches inside inline code or fenced code blocks are ignored. Each entity is enriched once per Claude Code session.

## Requirements

The plugin uses local CLIs and silently skips entities that cannot be fetched:

- `gh` authenticated for GitHub
- One of: `acli` (default) or `jira` (ankitpokhrel/jira-cli) authenticated for Jira
- `sentry` authenticated for Sentry
- Node.js available as `node`

## Privacy and security

This plugin fetches referenced third-party context and injects it into the Claude Code conversation before Claude processes your prompt.

It does not store credentials. It relies on your existing CLI authentication for `gh`, `acli`, and `sentry`.

Session dedupe state is stored under `${CLAUDE_PLUGIN_DATA}/seen.json` and contains only reference IDs already enriched in the current session.

## How it works

The plugin registers three Claude Code hooks (see `hooks/hooks.json`):

- **`UserPromptSubmit`** -> `hooks/auto-enrich.mjs`. The main hook. Reads the submitted prompt JSON from stdin, detects references, fetches markdown via local CLIs, and emits the enriched context Claude sees.
- **`SessionStart`** -> `hooks/discover.mjs`. Scans `~/.claude/auto-enrich/providers/` (and any trusted project dirs) for custom `*.provider.mjs` files, validates each against the contract, and writes a manifest the prompt hook reads.
- **`SessionStart` (matcher: `compact`) and `PreCompact`** -> `hooks/compact-cleanup.mjs`. Stashes the session's seen-id list before a compaction and re-surfaces "previously attached" references after, so dedup state survives compaction without starving fresh refs.

Claude Code injects the prompt hook's `additionalContext` as context before the user prompt is processed.

## Install

```bash
claude plugin marketplace add zhebil/claude-code-plugins
claude plugin install auto-enrich@zhebil-tools
```

Then reload plugins or restart Claude Code:

```text
/reload-plugins
```

## Disable

```bash
claude plugin disable auto-enrich@zhebil-tools
```

## Configuration

The plugin ships a setup skill. Inside Claude Code, type:

```text
/auto-enrich:configure-auto-enrich
```

and press enter. Claude will:

- Briefly explain what the plugin does and why it needs your CLIs (`gh`, `acli` / `jira`, `sentry`) to be authenticated.
- Detect what you have installed and authed in one pass.
- Show your current config (or note that defaults apply) and list what you can change - toggle providers, switch the Jira backend between `acli` and `jira-cli`, scaffold a custom provider, etc.
- Make only the changes you ask for, with a diff preview before writing.

The skill is **user-invoked only** (`disable-model-invocation: true`) - Claude won't trigger it from generic mentions of GitHub / Jira / Sentry. You always have to type the slash command.

If you skip configuration entirely, the plugin runs with defaults: every provider on, `acli` for Jira, no trusted projects.

Source: [skills/configure-auto-enrich/SKILL.md](skills/configure-auto-enrich/SKILL.md).

The config lives at `${CLAUDE_PLUGIN_DATA}/config.json` (or
`~/.claude/auto-enrich.json` if `CLAUDE_PLUGIN_DATA` is not set):

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

A missing or invalid file falls back to defaults (every provider on,
acli for jira, no trusted projects).

### Keys

| Key | Type | Default | Effect |
|---|---|---|---|
| `providers.<name>.enabled` | boolean | `true` | When `false`, the provider's `prepare`/`detect`/`fetch` are not run. Built-in `<name>` values: `github-issue`, `github-repo`, `jira`, `sentry`. |
| `providers.jira.cli` | `"acli" \| "jira-cli"` | `"acli"` | Backend CLI for the Jira provider. `"jira-cli"` selects ankitpokhrel/jira-cli (binary `jira`). Unknown values fall back to `"acli"`. |
| `trustedProjects` | `string[]` | `[]` | Absolute project-root paths whose `<cwd>/.claude/auto-enrich/providers/*.provider.mjs` files are loaded at `SessionStart`. Match is exact against the resolved cwd - subdirectories of a trusted entry are NOT trusted. Honored only when set in the GLOBAL config; an in-repo config cannot grant itself trust. See [docs/custom-providers.md](docs/custom-providers.md#project-level-providers) for the security model. |

Provider-specific keys (e.g. `jira.cli`) live under
`providers.<name>` alongside `enabled`. Unknown keys are ignored, so
adding a key for a future provider is safe.

## Where data lives

Claude Code sets `CLAUDE_PLUGIN_DATA` to a per-plugin cache directory
when it runs the hook. Outside Claude Code (e.g. running the hook by
hand for a smoke test), the fallbacks are `~/.claude/auto-enrich.json`
for the config and `~/.cache/claude-auto-enrich/` for runtime files.
The plugin writes:

- `${CLAUDE_PLUGIN_DATA}/config.json` - user config (also at `~/.claude/auto-enrich.json` when the env var is unset).
- `${CLAUDE_PLUGIN_DATA}/seen.json` - per-session dedup cache plus the post-compact stash.
- `${CLAUDE_PLUGIN_DATA}/discovery.json` - manifest of validated custom-provider paths written by the `SessionStart` hook.

## Debugging

- Provider warnings (validation failures, modules that no longer satisfy the contract, unreadable directories) are written to stderr as lines beginning `auto-enrich:`. The visible enrichment summary uses the `Auto-enriched:` prefix.
- `cat $CLAUDE_PLUGIN_DATA/discovery.json` shows exactly which custom providers `SessionStart` validated and the source (`global` vs `project`) of each entry.
- `cat $CLAUDE_PLUGIN_DATA/seen.json` shows the per-session dedup cache and the post-compact stash.
- Run the prompt hook directly with a temp data dir to see the full envelope without touching your real session cache - see [Test the hook directly](#test-the-hook-directly) below.

## Custom providers

Drop `*.provider.mjs` files into `~/.claude/auto-enrich/providers/` and
restart Claude Code. A `SessionStart` hook validates each file once per
session and writes a manifest the prompt hook reads.

For the full interface, lifecycle, validation rules, and worked
examples, see [docs/custom-providers.md](docs/custom-providers.md).

## Test the hook directly

```bash
printf '%s' '{"session_id":"test","hook_event_name":"UserPromptSubmit","cwd":"'$PWD'","user_prompt":"look at https://github.com/anthropics/claude-code"}' \
  | CLAUDE_PLUGIN_DATA="$(mktemp -d)" node hooks/auto-enrich.mjs
```

## Release

Bump `.claude-plugin/plugin.json` version, validate, then tag:

```bash
claude plugin validate plugins/auto-enrich
claude plugin tag plugins/auto-enrich --dry-run
claude plugin tag plugins/auto-enrich --push
```
