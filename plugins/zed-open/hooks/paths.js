const SEG = String.raw`\.?[\w@+-](?:[\w.@+-]*[\w@+-])?`
const STEP = String.raw`(?:${SEG}|\.{1,2})`
const PATH = [
  String.raw`(?:~|\.{1,2})?\/(?:${STEP}\/)*${SEG}\/?`,
  String.raw`${SEG}(?:\/${STEP})*\/(?:${SEG}\/?)?`,
  String.raw`[\w@+-]+(?:\.[\w@+-]+)*\.[A-Za-z][A-Za-z0-9]{0,9}`,
].join('|')
const LINE = String.raw`(?::\d+(?::\d+)?)?`

const IN_TEXT = new RegExp(String.raw`(?<![\w/.~@+:-])(${PATH})(${LINE})(?![\w/@+-]|\.\w)`, 'g')
const WHOLE = new RegExp(String.raw`^(${PATH})(${LINE})$`)
const SPANS =
  /(```|~~~)[\s\S]*?(?:\1|$)|!?\[[^\]\n]*\]\([^)\n]*\)|<[a-z][a-z0-9+.-]*:[^>\n]*>|[a-z][a-z0-9+.-]*:\/\/[^\s)>]+|`[^`\n]+`/gi
const LINK = /^\[([^\]\n]*)\]\(([^)\n]*)\)$/
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

function split(text) {
  const parts = []
  let at = 0
  for (const m of text.matchAll(SPANS)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index), isFree: true })
    parts.push({ text: m[0], isFree: false })
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at), isFree: true })
  return parts
}

function decoded(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return undefined
  }
}

function codeSpan(span) {
  if (!span.startsWith('`') || span.startsWith('``')) return undefined
  const m = WHOLE.exec(span.slice(1, -1))
  return m ? { path: m[1], line: m[2] } : undefined
}

function linkSpan(span) {
  const m = LINK.exec(span)
  if (!m || span.startsWith('!')) return undefined
  const target = m[2].trim().replace(/[?#].*$/, '')
  if (target === '' || SCHEME.test(target)) return undefined
  const whole = WHOLE.exec(decoded(target) ?? '')
  return whole ? { label: m[1], path: whole[1], line: whole[2] } : undefined
}

export function candidates(text) {
  const found = new Set()
  for (const part of split(text)) {
    if (part.isFree) {
      for (const m of part.text.matchAll(IN_TEXT)) found.add(m[1])
    } else {
      const span = codeSpan(part.text) ?? linkSpan(part.text)
      if (span) found.add(span.path)
    }
  }
  return [...found]
}

function normalize(path) {
  const out = []
  for (const seg of path.split('/')) {
    if (seg === '..') out.pop()
    else if (seg !== '' && seg !== '.') out.push(seg)
  }
  return `/${out.join('/')}`
}

export function placesOf(path, { cwd, root, home }) {
  if (path.startsWith('~/')) return home ? [normalize(home + path.slice(1))] : []
  if (path.startsWith('/')) return [normalize(path)]
  return [...new Set([cwd, root].filter(Boolean).map((base) => normalize(`${base}/${path}`)))]
}

const escapeSegment = (seg) =>
  encodeURIComponent(seg).replace(/[()!*']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export function hrefOf({ path, isDir }, line = '') {
  const url = `file://${path.split('/').map(escapeSegment).join('/')}`
  if (isDir) return path === '/' ? url : `${url}/`
  return line ? `${url}#L${line.slice(1)}` : url
}

export function targetOf(href) {
  if (!href.startsWith('file:///')) return undefined
  const [url, fragment = ''] = href.split('#')
  const path = decoded(url.slice('file://'.length).replace(/(.)\/$/, '$1'))
  if (path === undefined) return undefined
  const line = /^L(\d+(?::\d+)?)$/.exec(fragment)?.[1]
  return { path, arg: line ? `${path}:${line}` : path, isDir: url.endsWith('/') }
}

export function zedArgs({ path, arg, isDir }, root) {
  const isInside = Boolean(root) && path.startsWith(`${root}/`)
  const withRoot = Boolean(root) && path !== root && (!isDir || isInside)
  return ['-e', ...(withRoot ? [root] : []), arg]
}

const escapeLabel = (text) => text.replace(/[\\`*_[\]~<]/g, '\\$&')

export function linkify(text, found) {
  return split(text)
    .map((part) => {
      if (part.isFree) {
        return part.text.replace(IN_TEXT, (all, path, line) =>
          found.has(path) ? `[${escapeLabel(all)}](${hrefOf(found.get(path), line)})` : all,
        )
      }
      const code = codeSpan(part.text)
      if (code) return found.has(code.path) ? `[${part.text}](${hrefOf(found.get(code.path), code.line)})` : part.text
      const link = linkSpan(part.text)
      if (link && found.has(link.path)) return `[${link.label}](${hrefOf(found.get(link.path), link.line)})`
      return part.text
    })
    .join('')
}
