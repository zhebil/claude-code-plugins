# defer-artifact

Claude Code mod that puts the Artifact tool behind tool search. Its description is about 12k tokens of publishing instructions, and Claude Code loads it up front into every interactive session, whether or not the session ever publishes a page. With this mod only the tool's name sits in context. When you ask for an artifact, Claude loads the tool with ToolSearch and uses it as usual.

Measured on Claude Code 2.1.310 with Opus 5.5, tokens billed on the first request:

| Setup | Session start | Each subagent start |
| --- | --- | --- |
| Artifact loaded up front (default) | 28.3k | 22.9k |
| With this mod | 16.1k | 10.6k |
| Artifact turned off (`disableArtifact`) | 15.0k | - |

A session that does publish pays the ~12k once, on the turn that loads the tool. The prompt cache survives it: the next request reads the whole earlier prompt from cache and writes only the loaded schema.

## What changes

- The guidance that invites Claude to publish without being asked lives in the tool description, so Claude reads it only after it has chosen to use the tool.
- The first artifact request in a session costs an extra ToolSearch call. Claude sometimes loads `ArtifactData` and `ArtifactComments` first; both were deferred already.
- Everything else stays: the bundled `artifact-*` skills, comments, the shared database and live updates.

Background: [anthropics/claude-code#91395](https://github.com/anthropics/claude-code/issues/91395) and [#102898](https://github.com/anthropics/claude-code/issues/102898).

## Requirements

Claude Code 2.1.287 or later (mods), signed in to a claude.ai account that has artifacts.

## Test

```bash
claude plugin validate . && claude plugin test
```
