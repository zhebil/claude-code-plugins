import { expect, test } from 'claude-code/testing'
import { REPLY } from './fixtures/diagrams.mjs'
import recorded from './fixtures/layouts.mjs'

const CTRL_CLICK = { isControlHeld: true, isCommandHeld: false, sinceModifier: 9, sinceMouseDown: 0.4 }
const HREF = 'file:///work/app/src/main.rs#L40'

const message = (text: string) =>
  ({
    plugin: 'reply-view',
    component: 'AssistantMessage',
    requestId: 'msg-1',
    surface: 'terminal',
    viewport: { columns: 120, rows: 40, isFullscreen: true },
    props: { text, isFirstOfReply: true, isSummary: false },
  }) as const

test('a block with a diagram and a path draws the diagram and links the path', async ($, on) => {
  const runs: string[][] = []
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.root', () => ({ value: '/work/app' }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.stat', ($, e) =>
    e.path === '/work/app/src/main.rs' ? { value: { kind: 'file', size: 0, mtimeMs: 0 } } : { deny: 'ENOENT' },
  )
  on('process.run', ($, e) => {
    if (e.argv[0] === 'node') {
      const layouts = recorded[JSON.stringify(JSON.parse(e.init?.stdin ?? '[]'))] ?? null
      return { value: { exitCode: 0, stdout: JSON.stringify(layouts), stderr: '' } }
    }
    if (e.argv[0] === 'osascript') return { value: { exitCode: 0, stdout: JSON.stringify(CTRL_CLICK), stderr: '' } }
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const ui = await $.ui.mount(message(`${REPLY}\n\nFixed it in \`src/main.rs:40\`.`))
  const md = await ui.find({ key: 'reply-view-msg-1' })
  const text = md?.props.text ?? ''
  expect(text).toContain('```text')
  expect(text).toContain('│ kickoff │───►│ propose │')
  expect(text).not.toContain('```mermaid')
  expect(text).toContain(`Fixed it in [\`src/main.rs:40\`](${HREF}).`)
  expect(md?.props.pressableLinks).toEqual([HREF])
  await ui.press({ key: 'reply-view-msg-1', link: { href: HREF } })
  expect(runs).toEqual([['zed', '-e', '/work/app', '/work/app/src/main.rs:40']])
})
