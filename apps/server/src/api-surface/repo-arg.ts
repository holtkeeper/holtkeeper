import { type HoltkeeperConfig, fleetPatterns } from '@holtkeeper/core'
import type { GitForge } from '@holtkeeper/forge'
import type { AnalysisStore } from '@holtkeeper/store'

const SSH =
  /^(?:(?:ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|[^@/\s]+@([^:/\s]+):)(.+)$/i

const cleanPath = (path: string) =>
  path
    .replace(/\/-\/.*$/, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')

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
    const trimmed = value.trim()
    const separator = trimmed.indexOf(':')
    const forgePart = separator > 0 ? trimmed.slice(0, separator).toLowerCase() : ''
    const named = names.find((name) => name.toLowerCase() === forgePart)
    if (named) return `${named}:${cleanPath(trimmed.slice(separator + 1))}`
    // A web address written without its scheme, e.g. gitlab.com/group/app.
    const text = /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(trimmed) ? `https://${trimmed}` : trimmed

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

/** The HTTP status a forge client's error carries, when it has one. */
const statusOf = (error: unknown) => {
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
  return typeof status === 'number' ? status : undefined
}

/** How long `knownRepoChecker` trusts an answer: a known repository long, an unknown one briefly. */
const KNOWN_TTL_MS = 30 * 60_000
const UNKNOWN_TTL_MS = 60_000
const CHECKED_MAX = 2000

/**
 * The `forge:path` Holtkeeper knows `value` by, spelled as the forge spells it, or `undefined`
 * when it knows no such repository: one with a stored analysis is known as written; otherwise
 * the forge is asked (`getRepository`), which also corrects the case of the path. A forge that
 * is not configured is unknown; a forge outage or a client that cannot be built is no proof, so
 * the value is then passed on as written. Answers are kept for a while.
 */
export function knownRepoChecker(deps: {
  analyses: Pick<AnalysisStore, 'latestHeads'>
  /** Whether `forge` is a configured forge id. */
  configured: (forge: string) => boolean
  /** The forge client of a configured forge id; asked only for repositories without analyses. */
  forgeOf: (forge: string) => GitForge | undefined
  now: () => Date
}): (repo: string) => Promise<string | undefined> {
  const checked = new Map<string, { at: number; known: string | undefined }>()
  return async (value) => {
    const separator = value.indexOf(':')
    if (separator < 1 || separator === value.length - 1) return value
    const repo = { forge: value.slice(0, separator), path: value.slice(separator + 1) }
    if (!deps.configured(repo.forge)) return undefined
    const now = deps.now().getTime()
    const hit = checked.get(value)
    if (hit && now - hit.at < (hit.known ? KNOWN_TTL_MS : UNKNOWN_TTL_MS)) return hit.known
    const remember = (known: string | undefined) => {
      checked.set(value, { at: now, known })
      if (checked.size > CHECKED_MAX) checked.delete(checked.keys().next().value ?? value)
      return known
    }
    if ((await deps.analyses.latestHeads({ repo })).length > 0) return remember(value)
    let forge: GitForge | undefined
    try {
      forge = deps.forgeOf(repo.forge)
    } catch {
      // A forge whose client cannot be built is down, not proof that the repository is missing.
      return value
    }
    if (!forge || typeof forge.getRepository !== 'function') return value
    return forge.getRepository(repo.path).then(
      (found) => remember(found.path ? `${repo.forge}:${found.path}` : value),
      // Only a forge that says the repository is not there makes it unknown; an outage does not.
      (error: unknown) => (statusOf(error) === 404 ? remember(undefined) : value),
    )
  }
}
