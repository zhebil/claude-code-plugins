import { pressLink } from './click.js'
import { existingPaths } from './lookup.js'
import { drawDiagrams } from './mermaid.js'
import { linkify } from './paths.js'

const MAX_TEXT = 100_000
const MAX_PRESSABLE = 256
const BULLET = '⏺'

const fileHrefs = (markdown) =>
  [...new Set([...markdown.matchAll(/\]\((file:\/\/[^)\s]+)\)/g)].map((m) => m[1]))].slice(0, MAX_PRESSABLE)

export async function renderReply($, e, next) {
  const text = e.props?.text
  if (e.surface !== 'terminal' || typeof text !== 'string') return next(e)
  const drawn = drawDiagrams($, text, e.viewport?.columns)
  const found = e.props.isSummary || text.length > MAX_TEXT ? new Map() : await existingPaths($, drawn)
  if (!found.size) return drawn === text ? next(e) : next({ ...e, props: { ...e.props, text: drawn } })
  const linked = linkify(drawn, found)
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
            key: `reply-view-${String(e.requestId)}`,
            text: linked,
            pressableLinks: fileHrefs(linked),
            onLinkPress: (link, press) => pressLink($, link, press),
          }),
        ],
      }),
    ],
  })
}
