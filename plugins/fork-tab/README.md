# fork-tab

Claude Code mod that adds a `/fork-new-tab` command. It forks the current session into a new terminal tab, running `claude --resume <session> --fork-session` in the same directory. The original session keeps going untouched.

- `/fork-new-tab <prompt>` sends `<prompt>` as the fork's first message.
- Typed mid-turn, it waits for the turn to end, so the fork gets the whole conversation.
- Prints nothing into the conversation. If no terminal could open the tab, a toast shows the command to run by hand.

Claude Code's built-in `/fork` forks in place; this one opens the fork beside it.

## Which terminal

The terminal the session runs in comes first: [cmux](https://cmux.dev) (`CMUX_WORKSPACE_ID` set), [Warp](https://www.warp.dev) (`TERM_PROGRAM=WarpTerminal`) or iTerm2 (`TERM_PROGRAM=iTerm.app`). Otherwise the first one installed wins, in the order Warp, cmux, iTerm2.

- **Warp** has no command to open a tab running a command, so the mod writes a Tab Config to `~/.warp/tab_configs/claude-fork.toml` and opens it with `warp://tab_config/claude-fork`. That config stays in Warp's `+` menu as "Claude fork", holding the last fork.
- **cmux** opens a surface in the current workspace with `cmux new-surface`, using the `cmux` on `PATH` or the one inside `cmux.app`.
- **iTerm2** opens a tab in its front window through AppleScript (the first run asks for Automation permission).

## Requirements

Claude Code 2.1.287 or later (mods), on macOS, with Warp, cmux or iTerm2.

## Test

```bash
claude plugin validate . && claude plugin test
```
