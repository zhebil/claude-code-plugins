import { renderReply } from './reply.js'
import { openInZed, target } from './zed.js'

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
    await openInZed($, [path], path)
    return {}
  })

  on('ui.render', { component: 'AssistantMessage' }, renderReply)
}
