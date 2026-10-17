# Contributing

## Validate changes

Run before opening a PR:

```bash
claude plugin validate .
claude plugin validate plugins/unfurl-context
node --check plugins/unfurl-context/hooks/unfurl-context.mjs
```

## Versioning

When changing plugin behavior, bump the version in:

```text
plugins/unfurl-context/.claude-plugin/plugin.json
```

Claude Code uses the plugin version for update detection.
