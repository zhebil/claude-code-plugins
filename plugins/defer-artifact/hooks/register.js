export function register(on) {
  on('tool.describe', { tool: 'Artifact' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: true }))
}
