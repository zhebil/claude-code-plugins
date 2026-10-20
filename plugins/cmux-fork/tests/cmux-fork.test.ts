import { expect, test } from 'claude-code/testing'
import { forkCommand } from '../hooks/register.js'

test('/fork-new opens a forked resume of the session in a new cmux tab', async ($, on) => {
  const runs: string[][] = []
  on('session.id', () => ({ value: 'abc-123' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('process.run', ($, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const answer = await $.command.run({ command: 'fork-new', args: '' })
  expect(runs).toEqual([
    ['cmux', 'new-surface', '--working-directory', '/work/app', '--command', "claude --resume 'abc-123' --fork-session", '--focus', 'true'],
  ])
  expect(answer).toEqual({})
})

test('passes the optional prompt to the fork, quoted for the shell', () => {
  expect(forkCommand('abc', "  try the other approach, don't push  ")).toBe(
    `claude --resume 'abc' --fork-session 'try the other approach, don'\\''t push'`,
  )
})
