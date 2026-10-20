# cmux-fork

Claude Code mod that adds a `/fork-new` command. It forks the current session into a new [cmux](https://cmux.dev) tab in the current workspace, running `claude --resume <session> --fork-session` in the same directory. The original session keeps going untouched.

- `/fork-new <prompt>` sends `<prompt>` as the fork's first message.
- Typed mid-turn, it waits for the turn to end, so the fork gets the whole conversation.
- Prints nothing into the conversation. If cmux is not reachable, a toast shows the command to run by hand.

Claude Code's built-in `/fork` forks in place; this one opens the fork beside it.

## Requirements

Claude Code 2.1.287 or later (mods), running inside cmux with the `cmux` CLI on `PATH`.

## Test

```bash
claude plugin validate . && claude plugin test
```
