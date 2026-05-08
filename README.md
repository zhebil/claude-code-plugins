# Claude Code Plugins

Personal Claude Code plugin marketplace.

## Plugins

### auto-enrich

Auto-enriches submitted prompts with compact context for referenced Jira tickets, GitHub PRs/issues/repos, and Sentry issues.

It runs as a `UserPromptSubmit` hook and uses local CLIs only. No AI calls are made by the plugin itself.

## Install

Add the marketplace:

```bash
claude plugin marketplace add zhebil/claude-code-plugins
```

Install the plugin:

```bash
claude plugin install auto-enrich@zhebil-tools
```

Reload plugins or restart Claude Code:

```text
/reload-plugins
```

## Update

```bash
claude plugin marketplace update zhebil-tools
claude plugin update auto-enrich@zhebil-tools
```

Then run `/reload-plugins` or restart Claude Code.

## Develop locally

Validate the marketplace and plugin:

```bash
claude plugin validate .
claude plugin validate plugins/auto-enrich
node --check plugins/auto-enrich/hooks/auto-enrich.mjs
```

Test the hook directly:

```bash
printf '%s' '{"session_id":"test","hook_event_name":"UserPromptSubmit","cwd":"'$PWD'","user_prompt":"look at https://github.com/anthropics/claude-code"}' \
  | CLAUDE_PLUGIN_DATA="$(mktemp -d)" node plugins/auto-enrich/hooks/auto-enrich.mjs
```

## Marketplace

This repository is a Claude Code marketplace because it contains:

```text
.claude-plugin/marketplace.json
```

Claude Code users can install plugins from it with `/plugin marketplace add zhebil/claude-code-plugins` or the equivalent CLI command.

## License

MIT
