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
- `acli` authenticated for Jira
- `sentry` authenticated for Sentry
- Node.js available as `node`

## Privacy and security

This plugin fetches referenced third-party context and injects it into the Claude Code conversation before Claude processes your prompt.

It does not store credentials. It relies on your existing CLI authentication for `gh`, `acli`, and `sentry`.

Session dedupe state is stored under `${CLAUDE_PLUGIN_DATA}/seen.json` and contains only reference IDs already enriched in the current session.

## How it works

A `UserPromptSubmit` command hook runs:

```bash
node ${CLAUDE_PLUGIN_ROOT}/hooks/auto-enrich.mjs
```

The hook reads the submitted prompt JSON from stdin, fetches matching references with local CLIs, and prints markdown to stdout. Claude Code injects stdout as context before the user prompt is processed.

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
