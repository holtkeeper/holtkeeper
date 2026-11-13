import type { RepoRef } from '@holtkeeper/forge'
import { type LatestVersions, majorsBehind } from '@holtkeeper/libraries'
import { evaluatePackages } from '@holtkeeper/licenses'
import type {
  AnalysisStore,
  AuditRunStore,
  LibraryEcosystem,
  LibraryStore,
} from '@holtkeeper/store'

import type { ApiCatalog, RepoFilter } from '../api-surface/catalog.ts'
import type { UsageIndex } from '../api-surface/usages.ts'
import {
  advisoriesByLibrary,
  bundleShares,
  groupUses,
  libraryKeyOf,
  licenseSightings,
  licensesOf,
  newestAuditFindings,
} from '../dependencies.ts'
import { fleetLibraryUses } from '../libraries.ts'
import { type KnowledgeToolsContext, searchKnowledge } from './knowledge.ts'

/** What `evaluateDependency` reads, limited to what one caller may see. */
export interface DependencyContext {
  analyses: AnalysisStore
  auditRuns: Pick<AuditRunStore, 'list'>
  catalog: ApiCatalog
  usages: UsageIndex
  canRead: RepoFilter
  /** Repositories whose analyzer results (licenses, bundles, Renovate) the caller may read. */
  canReadAnalyses: RepoFilter
  /** Repositories whose audits the caller may read. */
  canReadAudits: RepoFilter
  /** Repositories whose audit `repo.analyzers` turns off; their audit runs are left out. */
  auditOff?: () => Promise<RepoFilter>
  /** Repositories whose `bundle` analyzer `repo.analyzers` turns off; their bundles are left out. */
  bundleOff?: () => Promise<RepoFilter>
  knowledge: KnowledgeToolsContext
  libraries?: Pick<LibraryStore, 'getLibrary' | 'listVersions'>
  /** The teams of a repository (innermost config groups), named on every user. */
  ownerOf?: (repo: RepoRef) => string[]
  /** Latest registry versions, the source of "behind". */
  latest?: Pick<LatestVersions, 'all'>
}

export interface DependencyQuery {
  package: string
  ecosystem?: LibraryEcosystem | undefined
  version?: string | undefined
  /** The repository the dependency would be added to or upgraded in, as `forge:path`. */
  repo?: string | undefined
}

interface Resolved {
  package: string
  ecosystem: LibraryEcosystem
  version: string
  repo: string
}

const repoKey = (repo: { forge: string; path: string }) => `${repo.forge}:${repo.path}`
const code = (value: string) => `\`${value}\``

const kb = (bytes: number) =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${(bytes / 1000).toFixed(1)} kB`

async function fleetSection(context: DependencyContext, query: Resolved) {
  const lines: string[] = []
  const internal = (await context.catalog.packages(context.canRead, query.package)).filter(
    (pkg) => pkg.name === query.package,
  )
  for (const pkg of internal)
    lines.push(
      `- Published by ${code(repoKey(pkg.repo))}${pkg.version ? ` at ${pkg.version}` : ''}: an internal package, see get_package_api.${pkg.removed ? ' **Removed** from its repository: do not add it.' : ''}`,
    )

  const ref = { ecosystem: query.ecosystem, name: query.package }
  const key = libraryKeyOf(ref)
  const [record, versions, fleet, latest] = await Promise.all([
    context.libraries?.getLibrary(ref),
    context.libraries?.listVersions(ref) ?? [],
    fleetLibraryUses(context.analyses, {
      accept: context.canRead,
      usages: context.usages,
      catalog: context.catalog,
    }),
    context.latest?.all(),
  ])
  const newest =
    (fleet.internal.has(key) ? fleet.defined.get(key) : latest?.get(key)?.latest) ?? record?.latest
  if (record || newest)
    lines.push(
      `- ${record?.description ? `${record.description}. ` : ''}Newest release ${newest ?? 'unknown'}${record?.homepage ? `, ${record.homepage}` : ''}.`,
    )
  const wanted = versions.find((item) => item.version === query.version)
  if (wanted?.deprecated) lines.push(`- **${query.version} is deprecated:** ${wanted.deprecated}`)
  for (const item of versions.filter((entry) => entry.deprecated && entry !== wanted).slice(0, 3))
    lines.push(`- ${item.version} is deprecated: ${item.deprecated}`)

  const users = new Map<string, string[]>()
  for (const [origin, used] of groupUses(fleet.uses).get(key)?.repos ?? [])
    users.set(origin, [...used])
  const counts = new Map<string, string>()
  if (query.ecosystem === 'npm')
    for (const entry of await context.usages.entries(context.canRead)) {
      const used = entry.data.packages.find((pkg) => pkg.name === query.package && !pkg.local)
      if (!used) continue
      counts.set(entry.origin, `${used.count} uses in ${used.files} files`)
      if (!users.has(entry.origin))
        users.set(entry.origin, used.versions.length ? used.versions : used.ranges)
    }
  if (users.size) {
    const teams = new Set<string>()
    const rows = [...users]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([origin, used]) => {
        const separator = origin.indexOf(':')
        const owner =
          context.ownerOf?.({
            forge: origin.slice(0, separator),
            path: origin.slice(separator + 1),
          }) ?? []
        for (const team of owner) teams.add(team)
        const behind = newest
          ? Math.max(0, ...used.map((version) => majorsBehind(version, newest)))
          : 0
        const details = [
          used.join(', ') || 'version unknown',
          ...(behind ? [`${behind} major${behind === 1 ? '' : 's'} behind`] : []),
          ...(counts.has(origin) ? [counts.get(origin) ?? ''] : []),
          ...(owner.length ? [`team ${owner.join(', ')}`] : []),
        ]
        return `  - ${code(origin)}${origin === query.repo ? ' (yours)' : ''}: ${details.join('; ')}`
      })
    lines.push(
      `- Used by ${users.size} repositor${users.size === 1 ? 'y' : 'ies'}${teams.size ? ` of ${teams.size} team${teams.size === 1 ? '' : 's'}` : ''}:`,
      ...rows.slice(0, 30),
      ...(rows.length > 30
        ? [`  - …and ${rows.length - 30} more; who_uses lists them by team.`]
        : []),
    )
  } else if (!internal.length) lines.push('- No repository you can read uses it.')
  return lines
}

async function vulnerabilitySection(context: DependencyContext, query: Resolved) {
  const off = (await context.auditOff?.()) ?? (() => false)
  const findings = await newestAuditFindings(
    context.auditRuns,
    (repo) => context.canReadAudits(repo) && !off(repo),
  )
  const advisories =
    advisoriesByLibrary(findings).get(
      libraryKeyOf({ ecosystem: query.ecosystem, name: query.package }),
    ) ?? []
  if (!advisories.length)
    return [
      `- No advisory in the newest audits of ${findings.size} repositor${findings.size === 1 ? 'y' : 'ies'} you can read. Audits scan lockfiles, so versions no repository resolves were not checked.`,
    ]
  return advisories.map((advisory) => {
    const mark = advisory.versions.includes(query.version) ? ` **affects ${query.version}**,` : ''
    return `- ${advisory.severity} ${code(advisory.id)} ${advisory.summary} —${mark} seen at ${advisory.versions.join(', ')} in ${advisory.repos.map(code).join(', ')}; ${advisory.fixedVersions.length ? `fixed in ${advisory.fixedVersions.join(', ')}` : 'no fix yet'} (${advisory.url})`
  })
}

async function licenseSection(context: DependencyContext, query: Resolved) {
  const { libraries, policies } = await licenseSightings(context.analyses, context.canReadAnalyses)
  const seen =
    libraries.get(libraryKeyOf({ ecosystem: query.ecosystem, name: query.package })) ?? []
  if (!seen.length)
    return [
      '- No license scan of a repository you can read lists it; check the registry before adding it.',
    ]
  const lines = licensesOf(seen).map(
    (item) =>
      `- ${item.version}: ${item.licenses.join(' AND ') || 'unknown'} — ${item.verdicts.map(({ verdict, repos }) => `${verdict} in ${repos.map(code).join(', ')}`).join('; ')}`,
  )
  const inRepo = seen.some(({ origin }) => origin === query.repo)
  const policyOfRepo = policies.get(query.repo)
  const sample = seen.find(({ pkg }) => pkg.version === query.version) ?? seen[0]
  if (query.repo && !inRepo && policyOfRepo && sample) {
    const { name, version, ecosystem, licenses } = sample.pkg
    const [judged] = evaluatePackages(
      [{ name, version, ecosystem, licenses, sources: [] }],
      policyOfRepo,
    )
    if (judged)
      lines.push(
        `- Under the license policy of ${code(query.repo)}: ${judged.verdict}${judged.culprits?.length ? ` (${judged.culprits.join(', ')})` : ''}.`,
      )
  }
  return lines
}

async function bundleSection(context: DependencyContext, query: Resolved) {
  if (query.ecosystem !== 'npm') return []
  const off = (await context.bundleOff?.()) ?? (() => false)
  const shares = await bundleShares(
    context.analyses,
    (repo) => context.canReadAnalyses(repo) && !off(repo),
    query.package,
  )
  return shares.length
    ? shares.map(
        (share) =>
          `- ${code(share.repo)} ${share.target.replace(/^build (.+)$/, 'build `$1`')}: ${kb(share.gzip)} gzip${share.total ? ` (${((share.gzip / share.total) * 100).toFixed(1)}% of ${kb(share.total)})` : ''}, ${share.versions.join(', ') || 'version unknown'}, in ${share.entrypoints} entrypoint${share.entrypoints === 1 ? '' : 's'}`,
      )
    : ['- No bundle measurement of a repository you can read includes it.']
}

/**
 * What the organization knows about a dependency before it is added or upgraded, as Markdown:
 * who uses it at which versions, open advisories from the newest audits, licenses with the
 * verdicts of each repository's policy, its share of measured bundles and accepted team
 * knowledge about it. Only stored analyses are read; nothing is fetched from registries.
 */
export async function evaluateDependency(
  context: DependencyContext,
  input: DependencyQuery,
): Promise<string> {
  const query: Resolved = {
    package: input.package,
    ecosystem: input.ecosystem ?? 'npm',
    version: input.version ?? '',
    repo: input.repo ?? '',
  }
  const [fleet, vulnerabilities, licenses, bundles, knowledge] = await Promise.all([
    fleetSection(context, query),
    vulnerabilitySection(context, query),
    licenseSection(context, query),
    bundleSection(context, query),
    searchKnowledge(context.knowledge, {
      package: query.package,
      limit: 5,
      ...(query.repo && context.knowledge.repoOf(query.repo) ? { repo: query.repo } : {}),
    }),
  ])
  return [
    `# ${query.package}${query.version ? `@${query.version}` : ''} (${query.ecosystem})`,
    ['## In the organization', ...fleet].join('\n'),
    ['## Vulnerabilities', ...vulnerabilities].join('\n'),
    ['## Licenses', ...licenses].join('\n'),
    ...(bundles.length ? [['## Bundle size', ...bundles].join('\n')] : []),
    `## Team knowledge\n\n${knowledge}`,
  ].join('\n\n')
}
