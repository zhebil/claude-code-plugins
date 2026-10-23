import { targetOf, zedArgs } from './paths.js'
import { openInZed } from './zed.js'

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

export async function pressLink($, link, press) {
  const opened = targetOf(link.href)
  if (!opened) return
  const action = await actionOfClick($)
  if (action === 'open') await openInZed($, zedArgs(opened, await $.session.root()), opened.path)
  if (action === 'copy') await copyPath($, opened.arg, press.surface)
}
