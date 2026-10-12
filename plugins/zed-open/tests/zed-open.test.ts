import { expect, test } from 'claude-code/testing'
import { target } from '../hooks/register.js'

test('/zed opens the session directory and prints nothing', async ($, on) => {
  const runs: string[][] = []
  on('session.cwd', () => ({ value: '/work/app' }))
  on('process.run', ($, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const answer = await $.command.run({ command: 'zed', args: '' })
  expect(runs).toEqual([['zed', '/work/app']])
  expect(answer).toEqual({})
})

test('/zed falls back to open -a Zed when the CLI fails', async ($, on) => {
  const runs: string[][] = []
  on('session.cwd', () => ({ value: '/work/app' }))
  on('process.run', ($, e) => {
    runs.push(e.argv)
    return { value: { exitCode: e.argv[0] === 'zed' ? 127 : 0, stdout: '', stderr: '' } }
  })
  await $.command.run({ command: 'zed', args: 'src' })
  expect(runs).toEqual([['zed', '/work/app/src'], ['open', '-a', 'Zed', '/work/app/src']])
})

test('resolves the optional path against the session directory', () => {
  expect(target('/work/app', '')).toBe('/work/app')
  expect(target('/work/app', ' src/index.ts ')).toBe('/work/app/src/index.ts')
  expect(target('/work/app', '/tmp/x')).toBe('/tmp/x')
})
