import { expect, test } from 'claude-code/testing'
import { renderDiagrams } from '../hooks/register.js'

const REPLY = 'Flow:\n\n```mermaid\nflowchart LR\n  A[kickoff] --> B[propose]\n```\n\nDone.'

function message(text: string, surface: 'terminal' | 'desktop' = 'terminal') {
  return {
    plugin: 'mermaid-view',
    component: 'AssistantMessage',
    requestId: 'msg-1',
    surface,
    viewport: { columns: 120, rows: 40 },
    props: { text, isFirstOfReply: true, isSummary: false },
  } as const
}

test('swaps a mermaid block for a drawn diagram', async ($, on) => {
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = e.props.text
    return { type: 'Text', props: {}, children: [e.props.text] }
  })
  await $.ui.mount(message(REPLY))
  expect(drawn).toContain('```text')
  expect(drawn).toContain('kickoff')
  expect(drawn).toContain('►')
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

test('keeps the source when the diagram is invalid or too wide', () => {
  const broken = '```mermaid\nnot a diagram ((\n```'
  expect(renderDiagrams(broken, 120)).toBe(broken)
  expect(renderDiagrams(REPLY, 20)).toBe(REPLY)
})
