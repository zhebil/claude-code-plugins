# reply-view

Claude Code mod that changes how Claude's replies look in the terminal:

- **Mermaid diagrams as box art.** Mermaid blocks in Claude's replies are drawn as Unicode box art instead of showing the raw Mermaid source.
- **Clickable paths.** In the fullscreen terminal, file and folder paths in Claude's replies become links. Ctrl-click opens the file in [Zed](https://zed.dev), at its line when the path ends in `:line` or `:line:col`; a folder opens as a Zed project. A plain click copies the full path.
- **`/zed [path]`** opens the session's working directory, or a path inside it, in Zed. It works while Claude is busy.

A reply block can have both: its diagrams are drawn and its paths are linked in the same block.

The mod rewrites only what the terminal draws. Claude, the transcript and copied text still hold the original Mermaid and the plain paths. The Desktop app is left alone.

## How a diagram is drawn

Flowcharts and state diagrams are laid out by [ELK](https://eclipse.dev/elk/) and then drawn on a character grid. To fit the terminal, the mod tries the diagram's own direction first, then the other one (LR and TD), each time wrapping node labels at 24, 16 and 12 characters, and shows the first drawing that fits.

ELK is too large to load inside a mod, so it runs as a `node` child process (`layout/cli.mjs`). The source shows while the layout runs (a second or two on first sight), then the drawing replaces it.

[beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid)'s own text renderer draws the rest: sequence, class and ER diagrams, flowcharts with subgraphs, and every diagram when `node` is not on `PATH`.

A self-loop (`A --> A`) is drawn as a `↺` line inside its node.

When no drawing fits, or the diagram can't be drawn at all (gantt, pie and other types), the source stays and a line under it says why:

```
*reply-view: this diagram needs 97 columns, the terminal has 80*
```

## Which paths become links

A path is linked only when it exists on disk, so ordinary words never turn into links.

- Absolute paths (`/Users/me/app/src/main.rs`) and `~/` paths.
- Relative paths (`src/main.rs`, `./scripts/`, `../shared/x.ts`, `README.md`), looked up in the session's working directory first and then in its project root.
- Paths in prose, in inline code (`` `src/main.rs:40` ``), and as the target of a relative markdown link (`[guide](docs/guide.md)`).
- Not inside code fences (so not inside a drawn diagram either), and not inside `https://` or other URLs.

Dragging or double-clicking selects text as usual. Links appear only in the fullscreen renderer (`/tui fullscreen`); in the classic renderer the terminal handles clicks itself.

## How a click works

Warp hands a modified click to Claude Code as a plain one. When a link is clicked, the mod asks macOS (through `osascript`, which needs no permission) which modifier keys are held: Ctrl opens Zed, and so does a modifier let go after the mouse button went down; no modifier copies the path. If that check fails, the click opens Zed. Cmd-click is left alone, because Warp itself opens a hyperlink on Cmd-click with the file type's default app.

A click opens the path with `zed -e`, so Zed reuses a window instead of opening a new one. The session's project folder is passed along with a file, and with a folder inside the project. If a Zed window already has the project open, the file opens there, even when it lives outside the project. A folder that is already open is focused.

Clicks and `/zed` run the `zed` CLI, falling back to `open -a Zed`. A failure shows a toast; nothing is printed into the conversation, so Claude's context is unchanged.

## Requirements

Claude Code 2.1.287 or later (mods). `node` on `PATH` for ELK layouts. Zed with its CLI (`zed: install cli` from the command palette) or Zed in `/Applications` for links and `/zed`.

## Rebuild the renderer

`hooks/mermaid.bundle.mjs` is beautiful-mermaid's parser and text renderer bundled into one file, since a mod can import only files inside its own directory, each under 1 MiB. `layout/elk.bundled.js` is elkjs, copied in by the same script.

```bash
cd build && npm install && npm run bundle
```

## Test

```bash
claude plugin validate . && claude plugin test
```

The test sandbox can't run ELK, so the tests answer the layout call with layouts recorded in `tests/fixtures/layouts.mjs`. After changing the ELK graph or the test diagrams, record them again:

```bash
node tests/fixtures/record.mjs
```
