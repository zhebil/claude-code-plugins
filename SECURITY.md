# Security

This marketplace contains Claude Code plugins that execute local hook scripts.

## Reporting issues

Open a GitHub issue for security concerns that do not expose secrets. If a report contains sensitive information, contact the maintainer privately first.

## Credentials

`auto-enrich` does not store credentials. It uses existing CLI authentication for:

- GitHub CLI (`gh`)
- Atlassian CLI (`acli`)
- Sentry CLI (`sentry`)

Review hook code before installing, especially because Claude Code hooks run with your local user privileges.
