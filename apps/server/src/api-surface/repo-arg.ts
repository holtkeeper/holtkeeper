import { type HoltkeeperConfig, fleetPatterns } from '@holtkeeper/core'

const SSH =
  /^(?:(?:ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|[^@/\s]+@([^:/\s]+):)(.+)$/i

const cleanPath = (path: string) => path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')

const urlOf = (value: string) => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

const prefixOf = (url: URL) => url.pathname.replace(/\/+$/, '')

/**
 * Turns what people's agents know a repository by into the `forge:path` the tools take: a
 * `forge:path` of a configured forge stays as it is; a git remote or web URL (`https://`,
 * `ssh://`, `git@host:path`) becomes the path on the forge with that host (a web URL also has to
 * match the forge URL's port and path prefix, which is stripped; forges that share a host are
 * told apart by whose fleet covers the path); a bare path gets the only configured forge, or with
 * several the one forge whose fleet covers the path. Anything
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

    const covers = (name: string, path: string) => {
      const patterns = fleetPatterns({ fleet, teams }, name)
      return (
        patterns.include.some((glob) => new Bun.Glob(glob).match(path)) &&
        !patterns.exclude.some((glob) => new Bun.Glob(glob).match(path))
      )
    }
    const oneOf = (candidates: string[], path: string) => {
      if (candidates.length < 2) return candidates[0]
      const covering = candidates.filter((name) => covers(name, path))
      return covering.length === 1 ? covering[0] : undefined
    }

    if (/^https?:\/\//i.test(text)) {
      const remote = urlOf(text)
      if (!remote) return value
      const matching = names
        .flatMap((name) => {
          const url = urlOf(forges[name]?.url ?? '')
          if (!url || url.host.toLowerCase() !== remote.host.toLowerCase()) return []
          const prefix = prefixOf(url)
          return remote.pathname === prefix || remote.pathname.startsWith(`${prefix}/`)
            ? [{ name, prefix }]
            : []
        })
        .toSorted((one, other) => other.prefix.length - one.prefix.length)
      const longest = matching.filter((match) => match.prefix === matching[0]?.prefix)
      const path = cleanPath(remote.pathname.slice(longest[0]?.prefix.length ?? 0))
      const forge = oneOf(
        longest.map((match) => match.name),
        path,
      )
      return forge && path ? `${forge}:${path}` : value
    }

    const ssh = SSH.exec(text)
    if (ssh) {
      const host = (ssh[1] ?? ssh[2] ?? '').toLowerCase()
      const path = cleanPath(ssh[3] ?? '')
      const forge = oneOf(
        names.filter((name) => urlOf(forges[name]?.url ?? '')?.hostname.toLowerCase() === host),
        path,
      )
      return forge && path ? `${forge}:${path}` : value
    }

    const path = cleanPath(text)
    if (!path || path.includes(':') || /\s/.test(path)) return value
    const [only, ...others] = names
    if (only && !others.length) return `${only}:${path}`
    const covering = names.filter((name) => covers(name, path))
    return covering.length === 1 ? `${covering[0]}:${path}` : value
  }
}
