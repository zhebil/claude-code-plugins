export function quote(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

export function forkCommand(sessionId, prompt) {
  const command = `claude --resume ${quote(sessionId)} --fork-session`
  return prompt.trim() ? `${command} ${quote(prompt.trim())}` : command
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'fork-new',
        description: 'Fork this session into a new cmux tab',
        argumentHint: '[prompt]',
      })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'fork-new' }, async ($, e) => {
    const command = forkCommand(await $.session.id(), e.args ?? '')
    const argv = ['cmux', 'new-surface', '--working-directory', await $.session.cwd(), '--command', command, '--focus', 'true']
    try {
      const run = await $.process.run(argv)
      if (run.exitCode === 0) return {}
    } catch {}
    $.ui.toast(`Could not open a cmux tab. Run: ${command}`)
    return {}
  })
}
