import { parseMermaid, renderMermaidASCII } from './mermaid.bundle.mjs'
import { drawLayout, elkGraph } from './flowchart.js'

const FENCE = /^([ \t]*)```mermaid[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm
const FLOWCHART = /^\s*(graph|flowchart|stateDiagram)\b/i
const MARGIN = 4
const WRAP_WIDTHS = [Infinity, 24, 16, 12]
const GRID_SPACINGS = [
  [5, 5, 1],
  [3, 2, 1],
  [2, 2, 1],
]
const drawings = new Map()
const inFlight = new Map()
let elkUnavailable = false

const tidy = (art) =>
  art
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n+$/, '')

function widest(art) {
  return Math.max(...art.split('\n').map((line) => [...line].length))
}

function otherDirection(direction) {
  return direction === 'LR' || direction === 'RL' ? 'TD' : 'LR'
}

async function drawWithElk(source, layout) {
  if (!FLOWCHART.test(source)) return []
  let parsed
  try {
    parsed = parseMermaid(source)
  } catch {
    return []
  }
  if (parsed.subgraphs.length) return []
  const candidates = [parsed.direction, otherDirection(parsed.direction)].flatMap((direction) =>
    WRAP_WIDTHS.map((width) => elkGraph(parsed, direction, width)),
  )
  const layouts = await layout(candidates.map(({ graph }) => graph))
  return (layouts ?? []).flatMap((result, i) => {
    try {
      return result ? [tidy(drawLayout(result, candidates[i]))] : []
    } catch {
      return []
    }
  })
}

function drawWithGrid(source) {
  return GRID_SPACINGS.flatMap(([paddingX, paddingY, boxBorderPadding]) => {
    try {
      return [tidy(renderMermaidASCII(source, { colorMode: 'none', paddingX, paddingY, boxBorderPadding }))]
    } catch {
      return []
    }
  })
}

async function draw(source, layout) {
  const elk = await drawWithElk(source, layout)
  return [...new Set(elk.length ? elk : drawWithGrid(source))]
}

function drawingsOf(source, layout) {
  if (!inFlight.has(source)) {
    if (inFlight.size > 200) {
      inFlight.clear()
      drawings.clear()
    }
    inFlight.set(source, draw(source, layout).then((arts) => drawings.set(source, arts)))
  }
  return inFlight.get(source)
}

function replaceBlock(block, indent, arts, columns) {
  if (!arts.length) return `${block}\n${indent}*mermaid-view: could not draw this diagram*`
  const limit = columns ? columns - MARGIN - indent.length : Infinity
  const art = arts.find((candidate) => widest(candidate) <= limit)
  if (art) return `${indent}\`\`\`text\n${art}\n${indent}\`\`\``
  const needed = Math.min(...arts.map(widest)) + MARGIN + indent.length
  return `${block}\n${indent}*mermaid-view: this diagram needs ${needed} columns, the terminal has ${columns}*`
}

function replaceDrawn(text, columns) {
  return text.replace(FENCE, (block, indent, source) =>
    drawings.has(source) ? replaceBlock(block, indent, drawings.get(source), columns) : block,
  )
}

const sourcesOf = (text) => [...text.matchAll(FENCE)].map(([, , source]) => source)

export async function renderDiagrams(text, columns, layout = async () => null) {
  await Promise.all(sourcesOf(text).map((source) => drawingsOf(source, layout)))
  return replaceDrawn(text, columns)
}

function elkLayout($) {
  return async (graphs) => {
    if (elkUnavailable) return null
    try {
      const { exitCode, stdout } = await $.process.run(['node', `${$.plugin.root}/layout/cli.mjs`], {
        stdin: JSON.stringify(graphs),
        timeoutMs: 10_000,
      })
      if (exitCode === 0) return JSON.parse(stdout)
    } catch {}
    elkUnavailable = true
    return null
  }
}

export function register(on) {
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    const text = e.props?.text
    if (e.surface !== 'terminal' || typeof text !== 'string' || !text.includes('```mermaid')) return next(e)
    const pending = sourcesOf(text).filter((source) => !drawings.has(source))
    if (pending.length) {
      const layout = elkLayout($)
      Promise.all(pending.map((source) => drawingsOf(source, layout))).then(() => $.ui.invalidate('ui.render'))
    }
    return next({ ...e, props: { ...e.props, text: replaceDrawn(text, e.viewport?.columns) } })
  })
}
