import { type HoltkeeperConfig, fleetPatterns } from '@holtkeeper/core'

const REMOTE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|[^@/\s]+@([^:/\s]+):)(.+)$/i

const cleanPath = (path: string) => path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Turns what people's agents know a repository by into the `forge:path` the tools take: a
 * `forge:path` of a configured forge stays as it is; a git remote or web URL (`https://`,
 * `ssh://`, `git@host:path`) becomes the path on the forge with that host; a bare path gets the
 * only configured forge, or with several the one forge whose fleet covers the path. Anything
 * else (an unknown host, a path several forges cover) is returned unchanged, so the tool answers
 * with its own "no repository" message. Reads `config()` on every call.
 */
export function repoArgResolver(config: () => HoltkeeperConfig): (value: string) => string {
  return (value) => {
    const { forges, fleet, teams } = config()
    const names = Object.keys(forges)
    const text = value.trim()
    const separator = text.indexOf(':')
    if (separator > 0 && names.includes(text.slice(0, separator))) return text

    const remote = REMOTE.exec(text)
    if (remote) {
      const host = (remote[1] ?? remote[2] ?? '').toLowerCase()
      const forge = names.find((name) => hostOf(forges[name]?.url ?? '') === host)
      return forge ? `${forge}:${cleanPath(remote[3] ?? '')}` : value
    }

    const path = cleanPath(text)
    if (!path || path.includes(':') || /\s/.test(path)) return value
    const [only, ...others] = names
    if (only && !others.length) return `${only}:${path}`
    const covering = names.filter((name) => {
      const patterns = fleetPatterns({ fleet, teams }, name)
      return (
        patterns.include.some((glob) => new Bun.Glob(glob).match(path)) &&
        !patterns.exclude.some((glob) => new Bun.Glob(glob).match(path))
      )
    })
    return covering.length === 1 ? `${covering[0]}:${path}` : value
  }
}
