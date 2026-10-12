# mermaid-view

Claude Code mod that draws the Mermaid diagrams in Claude's replies as Unicode box art in the terminal, instead of showing the raw Mermaid source.

It rewrites only what the terminal draws. Claude, the transcript and copied text still hold the original Mermaid. The Desktop app is left alone.

A block stays as source when it fails to parse or when the drawing is wider than the terminal.

Supported diagrams are the ones [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) can draw as text: flowchart, state, sequence, class and ER.

## Requirements

Claude Code 2.1.287 or later (mods).

## Rebuild the renderer

`hooks/mermaid.bundle.mjs` is beautiful-mermaid's text renderer bundled into one file, since a mod can import only files inside its own directory, each under 1 MiB.

```bash
cd build && npm install && npm run bundle
```

## Test

```bash
claude plugin validate . && claude plugin test
```
