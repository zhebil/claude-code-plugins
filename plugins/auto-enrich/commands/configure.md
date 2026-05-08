---
description: View or edit auto-enrich provider settings (enable/disable, CLI choice)
---

You are configuring the **auto-enrich** plugin. Help the user view and edit the config file.

## Config location

The config lives at `$CLAUDE_PLUGIN_DATA/config.json` when that env var is set
(the normal case inside Claude Code). Otherwise the fallback is
`~/.claude/auto-enrich.json`.

## Current state

!ls -la "${CLAUDE_PLUGIN_DATA:-$HOME/.claude}/config.json" 2>/dev/null || echo "(no config file yet - defaults apply: every provider enabled)"

!cat "${CLAUDE_PLUGIN_DATA:-$HOME/.claude}/config.json" 2>/dev/null || true

## Schema

```jsonc
{
  "providers": {
    "github-issue": { "enabled": true },
    "github-repo":  { "enabled": true },
    "jira":         { "enabled": true, "cli": "acli" },   // "cli": "acli" | "jira-cli"
    "sentry":       { "enabled": true }
  }
}
```

- `enabled` defaults to `true` when omitted.
- `cli` is provider-specific. Today only the `jira` provider reads it.
- Unknown keys are ignored, so adding a key for a future provider is safe.

## What to do

1. Parse the file printed above (treat missing/invalid file as `{}`).
2. Show the user a clean summary of every built-in provider's current
   state (`github-issue`, `github-repo`, `jira`, `sentry`): enabled vs
   disabled, plus CLI choice for `jira`.
3. Ask the user what they want to change. Examples to suggest:
   - "disable sentry"
   - "switch jira to jira-cli"
   - "re-enable github-repo"
4. Once the user confirms, write the full updated JSON back to the same
   path (creating parent directories with `mkdir -p` if needed). Then
   re-print the new contents so the user can verify.

Do not edit the config file until the user has explicitly confirmed the
diff. If the user just wanted to view, stop after step 2.
