import { candidates, placesOf } from './paths.js'

const MAX_PATHS = 200
const MISS_TTL_MS = 3_000
const kinds = new Map()
let home

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

export async function existingPaths($, text) {
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
