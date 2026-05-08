# Contributing

## Validate changes

Run before opening a PR:

```bash
claude plugin validate .
claude plugin validate plugins/auto-enrich
node --check plugins/auto-enrich/hooks/auto-enrich.mjs
```

## Versioning

When changing plugin behavior, bump the version in:

```text
plugins/auto-enrich/.claude-plugin/plugin.json
```

Claude Code uses the plugin version for update detection.
