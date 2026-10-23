import { expect, test } from 'claude-code/testing'
import { renderDiagrams } from '../hooks/mermaid.js'
import { REPLY, SHAPES, WIDE } from './fixtures/diagrams.mjs'
import recorded from './fixtures/layouts.mjs'

const layoutAll = async (graphs: unknown) => recorded[JSON.stringify(graphs)] ?? null

const widest = (text: string) => Math.max(...text.split('\n').map((line) => [...line].length))

function message(text: string, surface: 'terminal' | 'desktop' = 'terminal') {
  return {
    plugin: 'reply-view',
    component: 'AssistantMessage',
    requestId: 'msg-1',
    surface,
    viewport: { columns: 120, rows: 40 },
    props: { text, isFirstOfReply: true, isSummary: false },
  } as const
}

test('shows the source, then swaps in the diagram ELK laid out', async ($, on) => {
  const renders: string[] = []
  const commands: string[][] = []
  on('process.run', async ($, e) => {
    commands.push([...e.argv])
    const layouts = await layoutAll(JSON.parse(e.init?.stdin ?? '[]'))
    return { value: { exitCode: 0, stdout: JSON.stringify(layouts), stderr: '' } }
  })
  on('ui.render', ($, e) => {
    renders.push(e.props.text)
    return { type: 'Text', props: {}, children: [e.props.text] }
  })
  await $.ui.mount(message(REPLY))
  expect(commands).toHaveLength(1)
  expect(commands[0]?.[0]).toBe('node')
  expect(commands[0]?.[1]).toEndWith('/layout/cli.mjs')
  expect(renders[0]).toBe(REPLY)
  const drawn = renders.at(-1) ?? ''
  expect(drawn).toContain('```text')
  expect(drawn).toContain('│ kickoff │───►│ propose │')
  expect(drawn).not.toContain('```mermaid')
  expect(drawn).toContain('Done.')
})

test('leaves replies without mermaid and the desktop app untouched', async ($, on) => {
  const seen: string[] = []
  on('ui.render', ($, e) => {
    seen.push(e.props.text)
    return { type: 'Text', props: {}, children: [e.props.text] }
  })
  await $.ui.mount(message('plain reply'))
  await $.ui.mount(message(REPLY, 'desktop'))
  expect(seen).toEqual(['plain reply', REPLY])
})

test('wraps labels and turns the flow to fit a narrower terminal', async () => {
  const wide = await renderDiagrams(WIDE, 200, layoutAll)
  const narrow = await renderDiagrams(WIDE, 100, layoutAll)
  expect(wide).toContain('│ Round-2 shapes: revisit or keep? (brand-2we.1) │───►│ DTCG tokens │')
  expect(narrow).toContain('│ (brand-2we.1) │')
  expect(narrow).toContain('клубочок')
  expect(widest(narrow)).toBeLessThanOrEqual(96)
})

test('says why it kept the source', async () => {
  const tooWide = await renderDiagrams(WIDE, 60, layoutAll)
  expect(tooWide).toStartWith(WIDE)
  expect(tooWide).toContain('*reply-view: this diagram needs 97 columns, the terminal has 60*')
  const pie = '```mermaid\npie title Pets\n  "Dogs" : 386\n```'
  expect(await renderDiagrams(pie, 120, layoutAll)).toBe(`${pie}\n*reply-view: could not draw this diagram*`)
})

test('draws shapes, edge styles, labels, cycles and self-loops', async () => {
  const drawn = await renderDiagrams(SHAPES, 120, layoutAll)
  expect(drawn).toContain('│ Start │')
  expect(drawn).toContain('◇──────────────◇')
  expect(drawn).toContain('╭─────────────╮')
  expect(drawn).toContain('│ Process it │')
  expect(drawn).toContain('│     ↺      │')
  expect(drawn).toContain(' yes ')
  expect(drawn).toContain('┆')
  expect(drawn).toContain('┃')
  expect(drawn.indexOf('Start')).toBeLessThan(drawn.indexOf('Is it valid?'))
})

test('falls back to the built-in renderer without node', async () => {
  const source = '```mermaid\ngraph TD\n  start --> finish\n```'
  const drawn = await renderDiagrams(source, 120, async () => null)
  expect(drawn).toContain('```text')
  expect(drawn).toContain('start')
  expect(drawn).toContain('▼')
})
