export function target(cwd, args) {
  const path = args.trim()
  if (!path) return cwd
  return path.startsWith('/') ? path : `${cwd}/${path}`
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'zed',
        description: 'Open the current directory, or a path in it, in Zed',
        argumentHint: '[path]',
        immediate: true,
      })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'zed' }, async ($, e) => {
    const path = target(await $.session.cwd(), e.args ?? '')
    for (const argv of [['zed', path], ['open', '-a', 'Zed', path]]) {
      try {
        const run = await $.process.run(argv)
        if (run.exitCode === 0) return {}
      } catch {}
    }
    $.ui.toast(`Could not open ${path} in Zed`)
    return {}
  })
}
