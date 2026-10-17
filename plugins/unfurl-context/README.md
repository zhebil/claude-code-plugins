# unfurl-context

Claude Code plugin that unfurls the tickets, PRs, files and errors you reference in a prompt into compact context Claude can read, the way Slack unfurls a pasted link. Paste `ABC-123` or a GitHub PR URL and Claude sees what it points to; no copy-paste, no AI calls, just your local CLIs.

## What it detects

- Jira URLs and bare keys like `ABC-123`
- GitHub PR/issue URLs, `owner/repo#123`, and `PR#123` in a GitHub repo
- GitHub repository URLs, including README content
- GitHub file URLs (`/blob/`, `/raw/`, `raw.githubusercontent.com`), with optional `#L10-L20` line anchors
- GitLab issue and merge request URLs (`gitlab.com/<group>/.../-/issues/N`, `.../-/merge_requests/N`), including subgroups
- GitLab project URLs (`gitlab.com/<group>/<project>`), including README content
- GitLab file URLs (`/-/blob/`, `/-/raw/`), with optional `#L10-20` or `#L10-L20` line anchors
- Sentry issue URLs

Matches inside inline code or fenced code blocks are ignored. Each entity is unfurled once per Claude Code session.

## Requirements

The plugin uses local CLIs and silently skips entities that cannot be fetched:

- `gh` authenticated for GitHub
- `glab` authenticated for GitLab
- One of: `acli` (default) or `jira` (ankitpokhrel/jira-cli) authenticated for Jira
- `sentry` authenticated for Sentry
- Node.js available as `node`

## Privacy and security

This plugin fetches referenced third-party context and injects it into the Claude Code conversation before Claude processes your prompt.

It does not store credentials. It relies on your existing CLI authentication for `gh`, `glab`, `acli`, and `sentry`.

Session dedupe state is stored under `${CLAUDE_PLUGIN_DATA}/seen.json` and contains only reference IDs already enriched in the current session.

## How it works

The plugin registers three Claude Code hooks (see `hooks/hooks.json`):

- **`UserPromptSubmit`** -> `hooks/unfurl-context.mjs`. The main hook. Reads the submitted prompt JSON from stdin, detects references, fetches markdown via local CLIs, and emits the enriched context Claude sees. Only real user prompts to the main agent are enriched; when the payload carries a subagent marker (`agent_id`/`agent_type`), the hook exits without enriching, so subagent task prompts and completions stay untouched. Blocks Claude Code injects into the prompt stream itself (`<task-notification>`, `<system-reminder>`, local command output, cross-session and teammate messages, ...) are stripped before scanning, so a background task reporting back never triggers a fetch. The whole `additionalContext` stays under Claude Code's 10,000-char hook output cap: file contents and READMEs are cut at 8,000 chars with a truncation note, and once the cap is reached the overflowing block is truncated and remaining references are left for a later prompt.
- **`SessionStart`** -> `hooks/discover.mjs`. Scans `~/.claude/unfurl-context/providers/` (and any trusted project dirs) for custom `*.provider.mjs` files, validates each against the contract, and writes a manifest the prompt hook reads.
- **`SessionStart` (matcher: `compact`) and `PreCompact`** -> `hooks/compact-cleanup.mjs`. Stashes the session's seen-id list before a compaction and re-surfaces "previously attached" references after, so dedup state survives compaction without starving fresh refs.

Claude Code injects the prompt hook's `additionalContext` as context before the user prompt is processed.

## Install

```bash
claude plugin marketplace add zhebil/claude-code-plugins
claude plugin install unfurl-context@zhebil-tools
```

Then reload plugins or restart Claude Code:

```text
/reload-plugins
```

## Disable

```bash
claude plugin disable unfurl-context@zhebil-tools
```

## Configuration

The plugin ships a setup skill. Inside Claude Code, type:

```text
/unfurl-context:configure
```

and press enter. Claude will:

- Briefly explain what the plugin does and why it needs your CLIs (`gh`, `glab`, `acli` / `jira`, `sentry`) to be authenticated.
- Detect what you have installed and authed in one pass.
- Show your current config (or note that defaults apply) and list what you can change - toggle providers, switch the Jira backend between `acli` and `jira-cli`, scaffold a custom provider, etc.
- Make only the changes you ask for, with a diff preview before writing.

The skill is **user-invoked only** (`disable-model-invocation: true`) - Claude won't trigger it from generic mentions of GitHub / GitLab / Jira / Sentry. You always have to type the slash command.

If you skip configuration entirely, the plugin runs with defaults: every provider on, `acli` for Jira, no trusted projects.

Source: [skills/configure/SKILL.md](skills/configure/SKILL.md).

The config lives at `${CLAUDE_PLUGIN_DATA}/config.json` (or
`~/.claude/unfurl-context.json` if `CLAUDE_PLUGIN_DATA` is not set):

```jsonc
{
  "providers": {
    "github-issue": { "enabled": true },
    "github-file":  { "enabled": true },
    "github-repo":  { "enabled": true },
    "gitlab-issue": { "enabled": true },
    "gitlab-file":  { "enabled": true },
    "gitlab-repo":  { "enabled": true },
    "jira":         { "enabled": true, "cli": "acli" },
    "sentry":       { "enabled": true }
  },
  "trustedProjects": []
}
```

A missing or invalid file falls back to defaults (every provider on,
acli for jira, no trusted projects).

### Per-project overrides

You can also drop a config at `<projectRoot>/.claude/unfurl-context.json` to
override the global config when working inside that repo. Useful for
turning off Jira or Sentry just in one project, or pinning a different
Jira backend per repo.

Merge granularity is one level inside `providers.<name>`: a project file
that says `{ "providers": { "jira": { "enabled": false } } }` does NOT
wipe out the global `cli` setting, both keys coexist with project values
winning on overlap.

```jsonc
// <projectRoot>/.claude/unfurl-context.json
{
  "providers": {
    "jira":   { "enabled": false },
    "sentry": { "enabled": false }
  }
}
```

`trustedProjects` is **silently ignored** when set in a project file - a
repo cannot grant itself custom-provider execution trust by editing its
own checked-in config. Trust is read only from the global config (same
threat model as before).

### Keys

| Key | Type | Default | Effect |
|---|---|---|---|
| `providers.<name>.enabled` | boolean | `true` | When `false`, the provider's `prepare`/`detect`/`fetch` are not run. Built-in `<name>` values: `github-issue`, `github-file`, `github-repo`, `gitlab-issue`, `gitlab-file`, `gitlab-repo`, `jira`, `sentry`. |
| `providers.jira.cli` | `"acli" \| "jira-cli"` | `"acli"` | Backend CLI for the Jira provider. `"jira-cli"` selects ankitpokhrel/jira-cli (binary `jira`). Unknown values fall back to `"acli"`. |
| `trustedProjects` | `string[]` | `[]` | Absolute project-root paths whose `<cwd>/.claude/unfurl-context/providers/*.provider.mjs` files are loaded at `SessionStart`. Match is exact against the resolved cwd - subdirectories of a trusted entry are NOT trusted. Honored only when set in the GLOBAL config; an in-repo config cannot grant itself trust. See [docs/custom-providers.md](docs/custom-providers.md#project-level-providers) for the security model. |

Provider-specific keys (e.g. `jira.cli`) live under
`providers.<name>` alongside `enabled`. Unknown keys are ignored, so
adding a key for a future provider is safe.

## Where data lives

Claude Code sets `CLAUDE_PLUGIN_DATA` to a per-plugin cache directory
when it runs the hook. Outside Claude Code (e.g. running the hook by
hand for a smoke test), the fallbacks are `~/.claude/unfurl-context.json`
for the config and `~/.cache/claude-unfurl-context/` for runtime files.
The plugin writes:

- `${CLAUDE_PLUGIN_DATA}/config.json` - user config (also at `~/.claude/unfurl-context.json` when the env var is unset).
- `${CLAUDE_PLUGIN_DATA}/seen.json` - per-session dedup cache plus the post-compact stash.
- `${CLAUDE_PLUGIN_DATA}/discovery.json` - manifest of validated custom-provider paths written by the `SessionStart` hook.

## Debugging

- Provider warnings (validation failures, modules that no longer satisfy the contract, unreadable directories) are written to stderr as lines beginning `unfurl-context:`. The visible enrichment summary uses the `Unfurled:` prefix.
- `cat $CLAUDE_PLUGIN_DATA/discovery.json` shows exactly which custom providers `SessionStart` validated and the source (`global` vs `project`) of each entry.
- `cat $CLAUDE_PLUGIN_DATA/seen.json` shows the per-session dedup cache and the post-compact stash.
- Run the prompt hook directly with a temp data dir to see the full envelope without touching your real session cache - see [Test the hook directly](#test-the-hook-directly) below.

## Custom providers

Drop `*.provider.mjs` files into `~/.claude/unfurl-context/providers/` and
restart Claude Code. A `SessionStart` hook validates each file once per
session and writes a manifest the prompt hook reads.

For the full interface, lifecycle, validation rules, and worked
examples, see [docs/custom-providers.md](docs/custom-providers.md).

## Test the hook directly

```bash
printf '%s' '{"session_id":"test","hook_event_name":"UserPromptSubmit","cwd":"'$PWD'","user_prompt":"look at https://github.com/anthropics/claude-code"}' \
  | CLAUDE_PLUGIN_DATA="$(mktemp -d)" node hooks/unfurl-context.mjs
```

To exercise the file provider (with a line anchor):

```bash
printf '%s' '{"session_id":"test","hook_event_name":"UserPromptSubmit","cwd":"'$PWD'","user_prompt":"see https://github.com/anthropics/claude-code/blob/main/README.md#L1-L40"}' \
  | CLAUDE_PLUGIN_DATA="$(mktemp -d)" node hooks/unfurl-context.mjs
```

## Release

Bump `.claude-plugin/plugin.json` version, validate, then tag:

```bash
claude plugin validate plugins/unfurl-context
claude plugin tag plugins/unfurl-context --dry-run
claude plugin tag plugins/unfurl-context --push
```
