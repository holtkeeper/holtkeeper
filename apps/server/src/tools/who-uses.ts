import type { RepoRef } from '@holtkeeper/forge'
import { type LatestVersions, majorsBehind } from '@holtkeeper/libraries'
import type { AnalysisStore, LibraryEcosystem } from '@holtkeeper/store'

import type { ApiCatalog, RepoFilter } from '../api-surface/catalog.ts'
import type { UsageIndex } from '../api-surface/usages.ts'
import { groupUses, libraryKeyOf } from '../dependencies.ts'
import { fleetLibraryUses } from '../libraries.ts'
import { type StackToolsContext, matchesTool, renderStackUsage, stackUseRows } from './stack.ts'

/** What `whoUses` reads, limited to what one caller may see. */
export interface WhoUsesContext {
  analyses: AnalysisStore
  catalog: ApiCatalog
  usages: UsageIndex
  /** Repositories in the caller's catalog reach. */
  canRead: RepoFilter
  /** The teams (config groups) of a repository. */
  ownerOf: (repo: RepoRef) => string[]
  latest?: Pick<LatestVersions, 'all'>
  /** Stack tools, for subjects that name a runtime, image or tool. */
  stack?: StackToolsContext
}

const MAX_ROWS = 40

const parseKey = (key: string): RepoRef => {
  const separator = key.indexOf(':')
  return { forge: key.slice(0, separator), path: key.slice(separator + 1) }
}

const ecosystemOf = (value: string): LibraryEcosystem | undefined =>
  value === 'npm' ? 'npm' : value.toLowerCase() === 'go' ? 'Go' : undefined

/** `npm:x`, `Go:x`, `tool:node` or a bare name, split into what it names. */
export function parseSubject(
  subject: string,
):
  | { kind: 'package'; ecosystem?: LibraryEcosystem; name: string }
  | { kind: 'tool'; name: string } {
  const value = subject.trim()
  const separator = value.indexOf(':')
  if (separator > 0) {
    const prefix = value.slice(0, separator)
    const rest = value.slice(separator + 1)
    if (prefix === 'tool' || prefix === 'image') return { kind: 'tool', name: value }
    const ecosystem = ecosystemOf(prefix)
    if (ecosystem && rest) return { kind: 'package', ecosystem, name: rest }
  }
  return { kind: 'package', name: value }
}

/**
 * Markdown of who uses a library, an internal package or a stack tool: teams → repositories →
 * versions, with how far each is behind the latest release, in at most `MAX_ROWS` rows. A bare
 * name is looked up as an npm package, then a Go module, then a stack tool. Reads stored records
 * only.
 */
export async function whoUses(context: WhoUsesContext, subject: string): Promise<string> {
  const parsed = parseSubject(subject)
  const toolName = parsed.kind === 'tool' ? parsed.name.replace(/^tool:/, '') : parsed.name
  if (parsed.kind === 'package') {
    const fleet = await fleetLibraryUses(context.analyses, {
      accept: context.canRead,
      usages: context.usages,
      catalog: context.catalog,
    })
    const libraries = groupUses(fleet.uses)
    const candidates: LibraryEcosystem[] = parsed.ecosystem ? [parsed.ecosystem] : ['npm', 'Go']
    for (const ecosystem of candidates) {
      const key = libraryKeyOf({ ecosystem, name: parsed.name })
      const users = libraries.get(key)
      if (!users) continue
      const internal = fleet.internal.has(key)
      // oxlint-disable-next-line no-await-in-loop -- at most one lookup, the loop returns
      const latest = internal ? fleet.defined.get(key) : (await context.latest?.all())?.get(key)
      const latestVersion = typeof latest === 'string' ? latest : latest?.latest
      return renderLibraryUsers(users.ref.name, ecosystem, users.repos, {
        internal,
        ...(latestVersion ? { latest: latestVersion } : {}),
        ownerOf: context.ownerOf,
      })
    }
  }
  if (context.stack) {
    const rows = stackUseRows(await context.stack.views())
    if (parsed.kind === 'tool' || rows.some((row) => matchesTool(row, toolName)))
      return renderStackUsage(rows, context.ownerOf, { tool: toolName })
  }
  return `No repository you can see uses ${subject}. Pass npm:<name>, Go:<module> or a stack tool such as node.`
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
  lines.push(
    '',
    'package_usage shows which exports they use; find_usages shows the code where your reach allows it.',
  )
  return lines.join('\n')
}
