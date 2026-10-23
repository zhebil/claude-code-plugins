import { candidates, linkify, placesOf, targetOf, zedArgs } from './paths.js'

const MAX_PATHS = 200
const MAX_TEXT = 100_000
const MAX_PRESSABLE = 256
const MISS_TTL_MS = 3_000
const BULLET = '⏺'
const MODIFIER_CLICK_WINDOW_S = 3
const MODIFIER_PROBE = [
  "ObjC.import('CoreGraphics')",
  'const s = $.kCGEventSourceStateCombinedSessionState',
  'const flags = $.CGEventSourceFlagsState(s)',
  'JSON.stringify({',
  '  isControlHeld: (flags & 0x40000) !== 0,',
  '  isCommandHeld: (flags & 0x100000) !== 0,',
  '  sinceModifier: $.CGEventSourceSecondsSinceLastEventType(s, $.kCGEventFlagsChanged),',
  '  sinceMouseDown: $.CGEventSourceSecondsSinceLastEventType(s, $.kCGEventLeftMouseDown),',
  '})',
].join('\n')
const kinds = new Map()
let home

export function target(cwd, args) {
  const path = args.trim()
  if (!path) return cwd
  return path.startsWith('/') ? path : `${cwd}/${path}`
}

async function openInZed($, args, path) {
  for (const argv of [['zed', ...args], ['open', '-a', 'Zed', path]]) {
    try {
      const run = await $.process.run(argv)
      if (run.exitCode === 0) return
    } catch {}
  }
  $.ui.toast(`Could not open ${path} in Zed`)
}

// Cmd is left alone because Warp opens the hyperlink itself on Cmd-click, with the default app.
export function clickAction({ isControlHeld, isCommandHeld, sinceModifier, sinceMouseDown }) {
  if (isControlHeld) return 'open'
  if (isCommandHeld) return 'none'
  const releasedSinceClick = sinceModifier < sinceMouseDown && sinceMouseDown < MODIFIER_CLICK_WINDOW_S
  return releasedSinceClick ? 'open' : 'copy'
}

// Warp hands a modified click to Claude Code as a plain press, so ask macOS which modifier was down.
async function actionOfClick($) {
  try {
    const run = await $.process.run(['osascript', '-l', 'JavaScript', '-e', MODIFIER_PROBE], { timeoutMs: 2_000 })
    if (run.exitCode === 0) return clickAction(JSON.parse(run.stdout))
  } catch {}
  return 'open'
}

async function copyPath($, text, surface) {
  const { isCopied } = await $.ui.copy({ text, surface })
  $.ui.toast(isCopied ? `Copied ${text} (Ctrl-click opens it in Zed)` : `Could not copy ${text}`)
}

async function kindOf($, path) {
  const cached = kinds.get(path)
  if (cached && (cached.kind || Date.now() - cached.at < MISS_TTL_MS)) return cached.kind
  if (kinds.size > 5_000) kinds.clear()
  const stat = await $.fs.stat(path).catch(() => undefined)
  const kind = stat?.kind === 'file' || stat?.kind === 'dir' ? stat.kind : null
  kinds.set(path, { kind, at: Date.now() })
  return kind
}

async function locate($, path, where) {
  for (const place of placesOf(path, where)) {
    const kind = await kindOf($, place)
    if (kind) return { path: place, isDir: kind === 'dir' }
  }
  return undefined
}

async function existingPaths($, text) {
  const paths = candidates(text).slice(0, MAX_PATHS)
  const found = new Map()
  if (!paths.length) return found
  home ??= (await $.env.get('HOME')) ?? ''
  const where = { cwd: await $.session.cwd(), root: await $.session.root(), home }
  await Promise.all(
    paths.map(async (path) => {
      const place = await locate($, path, where)
      if (place) found.set(path, place)
    }),
  )
  return found
}

const fileHrefs = (markdown) =>
  [...new Set([...markdown.matchAll(/\]\((file:\/\/[^)\s]+)\)/g)].map((m) => m[1]))].slice(0, MAX_PRESSABLE)

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

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props?.text
    if (e.surface !== 'terminal' || e.props.isSummary || typeof text !== 'string') return next(e)
    // mermaid-view may sit beneath this mod and rewrite the fence; drawing the block here would hide its diagram.
    if (text.length > MAX_TEXT || text.includes('```mermaid')) return next(e)
    const found = await existingPaths($, text)
    if (!found.size) return next(e)
    const linked = linkify(text, found)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    return Box({
      flexDirection: 'row',
      marginTop: 1,
      children: [
        Box({ flexShrink: 0, width: 2, children: [Text({ children: [e.props.isFirstOfReply ? BULLET : ' '] })] }),
        Box({
          flexDirection: 'column',
          flexGrow: 1,
          children: [
            Markdown({
              key: `zed-open-${String(e.requestId)}`,
              text: linked,
              pressableLinks: fileHrefs(linked),
              onLinkPress: async (link, press) => {
                const opened = targetOf(link.href)
                if (!opened) return
                const action = await actionOfClick($)
                if (action === 'open') await openInZed($, zedArgs(opened, await $.session.root()), opened.path)
                if (action === 'copy') await copyPath($, opened.arg, press.surface)
              },
            }),
          ],
        }),
      ],
    })
  })
}
