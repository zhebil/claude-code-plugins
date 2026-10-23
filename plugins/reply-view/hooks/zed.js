export function target(cwd, args) {
  const path = args.trim()
  if (!path) return cwd
  return path.startsWith('/') ? path : `${cwd}/${path}`
}

export async function openInZed($, args, path) {
  for (const argv of [['zed', ...args], ['open', '-a', 'Zed', path]]) {
    try {
      const run = await $.process.run(argv)
      if (run.exitCode === 0) return
    } catch {}
  }
  $.ui.toast(`Could not open ${path} in Zed`)
}
