import type { RepoRef } from '@holtkeeper/forge'
import { type LatestVersions, majorsBehind } from '@holtkeeper/libraries'
import type { AnalysisStore, LibraryEcosystem } from '@holtkeeper/store'

import type { ApiCatalog, RepoFilter } from '../api-surface/catalog.ts'
import type { UsageIndex } from '../api-surface/usages.ts'
import { groupUses, libraryKeyOf } from '../dependencies.ts'
import { fleetLibraryUses } from '../libraries.ts'

/** What `packageUsers` reads, limited to what one caller may see. */
export interface PackageUsersContext {
  analyses: AnalysisStore
  catalog: ApiCatalog
  usages: UsageIndex
  /** Repositories in the caller's catalog reach. */
  canRead: RepoFilter
  /** The owner teams of a repository. */
  ownerOf: (repo: RepoRef) => string[]
  latest?: Pick<LatestVersions, 'all'>
}

const MAX_ROWS = 40

const parseKey = (key: string): RepoRef => {
  const separator = key.indexOf(':')
  return { forge: key.slice(0, separator), path: key.slice(separator + 1) }
}

/** The library key of the Go module `name` names: the module itself, else the longest module path prefixing a package import path. */
const goModuleKey = (keys: Iterable<string>, name: string) => {
  const exact = libraryKeyOf({ ecosystem: 'Go', name })
  let best: string | undefined
  for (const key of keys) {
    if (key === exact) return key
    if (key.startsWith('Go:') && exact.startsWith(`${key}/`) && key.length > (best?.length ?? 0))
      best = key
  }
  return best ?? exact
}

/**
 * Markdown of who uses a library or an internal package: teams → repositories → versions, with
 * how far each is behind the latest release, in at most `MAX_ROWS` rows, and the repositories
 * (`forge:path`) it counted; `undefined` when no
 * repository the caller can see uses it. Without `ecosystem`, the name is looked up as an npm
 * package, then a Go module (a name with a `/` and no `@scope` is tried as Go first; a Go package
 * import path counts as its module). Reads stored records only.
 */
export async function packageUsers(
  context: PackageUsersContext,
  name: string,
  ecosystem?: LibraryEcosystem,
): Promise<{ text: string; repos: string[] } | undefined> {
  const fleet = await fleetLibraryUses(context.analyses, {
    accept: context.canRead,
    usages: context.usages,
    catalog: context.catalog,
  })
  const libraries = groupUses(fleet.uses)
  const goFirst = !name.startsWith('@') && name.includes('/')
  const candidates: LibraryEcosystem[] = ecosystem
    ? [ecosystem]
    : goFirst
      ? ['Go', 'npm']
      : ['npm', 'Go']
  for (const candidate of candidates) {
    const key =
      candidate === 'Go'
        ? goModuleKey(libraries.keys(), name)
        : libraryKeyOf({ ecosystem: candidate, name })
    const users = libraries.get(key)
    if (!users) continue
    const internal = fleet.internal.has(key)
    // oxlint-disable-next-line no-await-in-loop -- at most one lookup, the loop returns
    const latest = internal ? fleet.defined.get(key) : (await context.latest?.all())?.get(key)
    const latestVersion = typeof latest === 'string' ? latest : latest?.latest
    return {
      text: renderLibraryUsers(users.ref.name, candidate, users.repos, {
        internal,
        ...(latestVersion ? { latest: latestVersion } : {}),
        ownerOf: context.ownerOf,
      }),
      repos: [...users.repos.keys()],
    }
  }
  return undefined
}

function renderLibraryUsers(
  name: string,
  ecosystem: LibraryEcosystem,
  repos: ReadonlyMap<string, readonly string[]>,
  options: { internal: boolean; latest?: string; ownerOf: (repo: RepoRef) => string[] },
): string {
  const byTeam = new Map<string, [string, readonly string[]][]>()
  const versions = new Map<string, number>()
  for (const [origin, used] of repos) {
    const owner = options.ownerOf(parseKey(origin))
    const team = owner.length ? owner.join(', ') : 'no team'
    byTeam.set(team, [...(byTeam.get(team) ?? []), [origin, used]])
    for (const version of used) versions.set(version, (versions.get(version) ?? 0) + 1)
  }
  const lines = [
    `# ${name} (${ecosystem}${options.internal ? ', internal package' : ''}): ${repos.size} repositor${repos.size === 1 ? 'y' : 'ies'} of ${byTeam.size} team${byTeam.size === 1 ? '' : 's'}${options.latest ? `, latest ${options.latest}` : ''}`,
    `Versions: ${[...versions]
      .toSorted((a, b) => b[1] - a[1])
      .map(([version, count]) => `${version} (${count})`)
      .join(', ')}`,
  ]
  let listed = 0
  for (const [team, rows] of [...byTeam].toSorted(([a], [b]) => a.localeCompare(b))) {
    lines.push('', `## team ${team}`)
    for (const [origin, used] of rows.toSorted(([a], [b]) => a.localeCompare(b))) {
      if (listed >= MAX_ROWS) break
      listed += 1
      const behind = options.latest
        ? Math.max(0, ...used.map((version) => majorsBehind(version, options.latest ?? version)))
        : 0
      lines.push(
        `- \`${origin}\` ${used.join(', ')}${behind ? ` (${behind} major${behind === 1 ? '' : 's'} behind)` : ''}`,
      )
    }
  }
  if (repos.size > listed) lines.push('', `…and ${repos.size - listed} more repositories.`)
  return lines.join('\n')
}
