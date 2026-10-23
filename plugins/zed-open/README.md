# zed-open

Claude Code mod that opens things in [Zed](https://zed.dev):

- **Clickable paths in replies.** In the fullscreen terminal, file and folder paths in Claude's replies become links. Cmd-click opens the file in Zed, at its line when the path ends in `:line` or `:line:col`; a folder opens as a Zed project. A plain click copies the full path.
- **`/zed [path]`** opens the session's working directory, or a path inside it. It works while Claude is busy.

Both run with the `zed` CLI, falling back to `open -a Zed`. A failure shows a toast; nothing is printed into the conversation, so Claude's context is unchanged.

## Which paths become links

A path is linked only when it exists on disk, so ordinary words never turn into links.

- Absolute paths (`/Users/me/app/src/main.rs`) and `~/` paths.
- Relative paths (`src/main.rs`, `./scripts/`, `../shared/x.ts`, `README.md`), looked up in the session's working directory first and then in its project root.
- Paths in prose, in inline code (`` `src/main.rs:40` ``), and as the target of a relative markdown link (`[guide](docs/guide.md)`).
- Not inside code fences, and not inside `https://` or other URLs.

Dragging or double-clicking selects text as usual.

The terminal's mouse protocol has no way to carry the Cmd key, so a Cmd-click reaches Claude Code as a plain click. When a link is clicked, the mod asks macOS (through `osascript`, which needs no permission) whether Cmd is still held, or whether a modifier key was let go after the mouse button went down. If so, it opens Zed; otherwise it copies the path. If that check fails, the click opens Zed.

A click opens the path with `zed -e`, so Zed reuses a window instead of opening a new one. The session's project folder is passed along with a file, and with a folder inside the project. If a Zed window already has the project open, the file opens there, even when it lives outside the project. A folder that is already open is focused. Links appear only in the fullscreen renderer (`/tui fullscreen`); in the classic renderer the terminal handles clicks itself. Reply blocks that hold a Mermaid diagram are left to [mermaid-view](../mermaid-view) and get no links.

## Requirements

Claude Code 2.1.287 or later (mods), and Zed with its CLI (`zed: install cli` from the command palette) or Zed in `/Applications`.

## Test

```bash
claude plugin validate . && claude plugin test
```
