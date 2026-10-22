import { expect, test } from 'claude-code/testing'
import { forkCommand, warpTabConfig } from '../hooks/register.js'

const FORK = "claude --resume 'abc-123' --fork-session"

function stubSession(on, env: Record<string, string>, failing: string[] = []) {
  const runs: string[][] = []
  const writes: { path: string; text: string }[] = []
  on('session.id', () => ({ value: 'abc-123' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    runs.push(e.argv)
    const exitCode = failing.some((f) => e.argv.join(' ').includes(f)) ? 1 : 0
    return { value: { exitCode, stdout: '', stderr: '' } }
  })
  return { runs, writes }
}

test('opens the fork in a new Warp tab through a tab config', async ($, on) => {
  const { runs, writes } = stubSession(on, { TERM_PROGRAM: 'WarpTerminal', HOME: '/Users/me' })
  const answer = await $.command.run({ command: 'fork-new-tab', args: '' })
  expect(runs).toEqual([
    ['open', '-Ra', 'Warp'],
    ['open', 'warp://tab_config/claude-fork'],
  ])
  expect(writes).toEqual([{ path: '/Users/me/.warp/tab_configs/claude-fork.toml', text: warpTabConfig('/work/app', FORK) }])
  expect(answer).toEqual({})
})

test('prefers cmux when the session runs inside it, even with Warp installed', async ($, on) => {
  const { runs } = stubSession(on, { CMUX_WORKSPACE_ID: 'ws', TERM_PROGRAM: 'ghostty' })
  await $.command.run({ command: 'fork-new-tab', args: '' })
  expect(runs).toEqual([['cmux', 'new-surface', '--working-directory', '/work/app', '--command', FORK, '--focus', 'true']])
})

test('falls back from Warp to cmux to iTerm by what is installed', async ($, on) => {
  const { runs } = stubSession(on, { TERM_PROGRAM: 'Apple_Terminal' }, ['Warp', 'new-surface'])
  await $.command.run({ command: 'fork-new-tab', args: '' })
  expect(runs.map((argv) => argv.slice(0, 3))).toEqual([
    ['open', '-Ra', 'Warp'],
    ['cmux', 'new-surface', '--working-directory'],
    ['/Applications/cmux.app/Contents/Resources/bin/cmux', 'new-surface', '--working-directory'],
    ['open', '-Ra', 'iTerm'],
    ['osascript', '-e', runs[4][2]],
  ])
  expect(runs[4][3]).toBe(`cd '/work/app' && ${FORK}`)
})

test('writes a tab config whose strings survive quotes in the command', () => {
  expect(warpTabConfig('/work/my "app"', "claude 'x'")).toBe(
    'name = "Claude fork"\n\n[[panes]]\nid = "fork"\ntype = "terminal"\ndirectory = "/work/my \\"app\\""\ncommands = ["claude \'x\'"]\n',
  )
})

test('passes the optional prompt to the fork, quoted for the shell', () => {
  expect(forkCommand('abc', "  try the other approach, don't push  ")).toBe(
    `claude --resume 'abc' --fork-session 'try the other approach, don'\\''t push'`,
  )
})
