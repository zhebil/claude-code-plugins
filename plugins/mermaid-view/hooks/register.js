import { renderMermaidASCII } from './mermaid.bundle.mjs'

const FENCE = /^([ \t]*)```mermaid[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm
const MARGIN = 4
const cache = new Map()

function draw(source) {
  if (cache.has(source)) return cache.get(source)
  let art = null
  try {
    art = renderMermaidASCII(source, { colorMode: 'none' })
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n+$/, '')
  } catch {}
  if (cache.size > 200) cache.clear()
  cache.set(source, art)
  return art
}

function widest(art) {
  return Math.max(...art.split('\n').map((line) => line.length))
}

export function renderDiagrams(text, columns) {
  return text.replace(FENCE, (block, indent, source) => {
    const art = draw(source)
    if (!art || (columns && widest(art) + indent.length > columns - MARGIN)) return block
    return `${indent}\`\`\`text\n${art}\n${indent}\`\`\``
  })
}

export function register(on) {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props?.text
    if (e.surface !== 'terminal' || typeof text !== 'string' || !text.includes('```mermaid')) return next(e)
    return next({ ...e, props: { ...e.props, text: renderDiagrams(text, e.viewport?.columns) } })
  })
}
