import { expect, test } from 'claude-code/testing'
import { candidates, hrefOf, linkify, placesOf, targetOf } from '../hooks/paths.js'

const WHERE = { cwd: '/work/app/src', root: '/work/app', home: '/Users/me' }

const reply = (text: string, isFirstOfReply = true) =>
  ({
    plugin: 'zed-open',
    component: 'AssistantMessage',
    requestId: 'msg-1',
    surface: 'terminal',
    viewport: { columns: 100, rows: 30, isFullscreen: true },
    props: { text, isFirstOfReply },
  }) as const

test('finds paths in prose, inline code and relative links, but not in fences or URLs', () => {
  const text = [
    'Saved `~/desk/notes/pr-body.md` and edited src/main.rs:12:4 plus README.md.',
    'See [the guide](docs/guide.md) and ./scripts/ or ../shared/x.ts.',
    'Not https://example.com/a/b.md or <file:///tmp/x>, nor:',
    '```sh',
    'cat /etc/hosts',
    '```',
  ].join('\n')
  expect(candidates(text)).toEqual([
    '~/desk/notes/pr-body.md',
    'src/main.rs',
    'README.md',
    'docs/guide.md',
    './scripts/',
    '../shared/x.ts',
  ])
})

test('does not take a trailing full stop or the start of a longer name', () => {
  expect(candidates('Open notes.md. Then a.jsx and x/y.md.')).toEqual(['notes.md', 'a.jsx', 'x/y.md'])
})

test('resolves ~, absolute and relative paths against cwd, then the project root', () => {
  expect(placesOf('~/desk/a.md', WHERE)).toEqual(['/Users/me/desk/a.md'])
  expect(placesOf('/tmp/../etc/hosts', WHERE)).toEqual(['/etc/hosts'])
  expect(placesOf('docs/x.md', WHERE)).toEqual(['/work/app/src/docs/x.md', '/work/app/docs/x.md'])
  expect(placesOf('../README.md', WHERE)).toEqual(['/work/app/README.md', '/work/README.md'])
})

test('file hrefs round-trip with lines and folders', () => {
  const file = hrefOf({ path: '/a b/(x).md', isDir: false }, ':12:4')
  expect(file).toBe('file:///a%20b/%28x%29.md#L12:4')
  expect(targetOf(file)).toEqual({ path: '/a b/(x).md', arg: '/a b/(x).md:12:4' })
  const dir = hrefOf({ path: '/work/app', isDir: true }, ':3')
  expect(dir).toBe('file:///work/app/')
  expect(targetOf(dir)).toEqual({ path: '/work/app', arg: '/work/app' })
  expect(targetOf('https://example.com')).toBeUndefined()
})

test('linkify keeps the label as written and only links found paths', () => {
  const found = new Map([
    ['src/main.rs', { path: '/work/app/src/main.rs', isDir: false }],
    ['docs/', { path: '/work/app/docs', isDir: true }],
  ])
  expect(linkify('Edit src/main.rs:3 and `docs/`, not lib/x.rs.', found)).toBe(
    'Edit [src/main.rs:3](file:///work/app/src/main.rs#L3) and [`docs/`](file:///work/app/docs/), not lib/x.rs.',
  )
  expect(linkify('Under my\\_dir/a\\_b.md', found)).toBe('Under my\\_dir/a\\_b.md')
})

function stubSession(on: any, existing: Record<string, 'file' | 'dir'>, runs: string[][], failZed = false) {
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.root', () => ({ value: '/work/app' }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.stat', ($: unknown, e: { path: string }) =>
    existing[e.path] ? { value: { kind: existing[e.path], size: 0, mtimeMs: 0 } } : { deny: 'ENOENT' },
  )
  on('process.run', ($: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    return { value: { exitCode: failZed && e.argv[0] === 'zed' ? 127 : 0, stdout: '', stderr: '' } }
  })
}

test('a click on a relative path opens it in Zed at its line', async ($, on) => {
  const runs: string[][] = []
  stubSession(on, { '/work/app/src/main.rs': 'file' }, runs)
  const ui = await $.ui.mount(reply('Fixed it in `src/main.rs:40`.'))
  const md = await ui.find({ key: 'zed-open-msg-1' })
  expect(md?.props.text).toBe('Fixed it in [`src/main.rs:40`](file:///work/app/src/main.rs#L40).')
  expect(md?.props.pressableLinks).toEqual(['file:///work/app/src/main.rs#L40'])
  await ui.press({ key: 'zed-open-msg-1', link: { href: 'file:///work/app/src/main.rs#L40' } })
  expect(runs).toEqual([['zed', '/work/app/src/main.rs:40']])
})

test('a click on a folder opens the folder, falling back to open -a Zed', async ($, on) => {
  const runs: string[][] = []
  stubSession(on, { '/Users/me/desk/notes': 'dir' }, runs, true)
  const ui = await $.ui.mount(reply('Drafts are in ~/desk/notes/ now.'))
  const md = await ui.find({ key: 'zed-open-msg-1' })
  expect(md?.props.text).toBe('Drafts are in [\\~/desk/notes/](file:///Users/me/desk/notes/) now.')
  await ui.press({ key: 'zed-open-msg-1', link: { href: 'file:///Users/me/desk/notes/' } })
  expect(runs).toEqual([
    ['zed', '/Users/me/desk/notes'],
    ['open', '-a', 'Zed', '/Users/me/desk/notes'],
  ])
})

test('a reply with no existing path is left to Claude Code', async ($, on) => {
  stubSession(on, {}, [])
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  const ui = await $.ui.mount(reply('Nothing at src/missing.rs here.'))
  expect(await ui.find({ key: 'zed-open-msg-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
})
