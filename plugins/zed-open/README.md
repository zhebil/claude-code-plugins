# zed-open

Claude Code mod that adds a `/zed` command. It opens the session's working directory in [Zed](https://zed.dev), or a path inside it with `/zed <path>`.

- Runs with the `zed` CLI, falling back to `open -a Zed` on macOS.
- Works while Claude is busy, and prints nothing into the conversation, so Claude's context is unchanged. A failure shows a toast.

## Requirements

Claude Code 2.1.287 or later (mods), and Zed with its CLI (`zed: install cli` from the command palette) or Zed in `/Applications`.

## Test

```bash
claude plugin validate . && claude plugin test
```
