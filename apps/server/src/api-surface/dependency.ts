import {
  type BundleTarget,
  bundleTargets,
  isBundleAnalysisData,
  totalSizes,
} from '@holtkeeper/bundles'
import {
  type LicensePolicyData,
  type LicensedPackage,
  evaluatePackages,
  licensesDataSchema,
} from '@holtkeeper/licenses'
import type {
  AnalysisStore,
  AuditRunStore,
  LibraryEcosystem,
  LibraryStore,
} from '@holtkeeper/store'
import type { Finding } from '@holtkeeper/vuln'

import type { ApiCatalog, RepoFilter } from './catalog.ts'
import { type McpKnowledgeContext, searchKnowledge } from './knowledge.ts'
import type { UsageIndex } from './usages.ts'

/** What `evaluateDependency` reads, limited to what one caller may see. */
export interface DependencyContext {
  analyses: Pick<AnalysisStore, 'latest'>
  auditRuns: Pick<AuditRunStore, 'list'>
  catalog: ApiCatalog
  usages: UsageIndex
  canRead: RepoFilter
  /** Repositories whose audits the caller may read. */
  canReadAudits: RepoFilter
  knowledge: McpKnowledgeContext
  libraries?: Pick<LibraryStore, 'getLibrary' | 'listVersions'>
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

/** Audit runs read to find the newest one of each repository. */
const auditPool = 1000

const repoKey = (repo: { forge: string; path: string }) => `${repo.forge}:${repo.path}`
const code = (value: string) => `\`${value}\``
const sameEcosystem = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

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
  const record = await context.libraries?.getLibrary(ref)
  const versions = (await context.libraries?.listVersions(ref)) ?? []
  if (record)
    lines.push(
      `- ${record.description ? `${record.description}. ` : ''}Newest release ${record.latest ?? 'unknown'}${record.homepage ? `, ${record.homepage}` : ''}.`,
    )
  const wanted = versions.find((item) => item.version === query.version)
  if (wanted?.deprecated) lines.push(`- **${query.version} is deprecated:** ${wanted.deprecated}`)
  for (const item of versions.filter((entry) => entry.deprecated && entry !== wanted).slice(0, 3))
    lines.push(`- ${item.version} is deprecated: ${item.deprecated}`)

  const users = new Map<string, string[]>()
  if (query.ecosystem === 'npm')
    for (const entry of await context.usages.entries(context.canRead)) {
      const used = entry.data.packages.find((pkg) => pkg.name === query.package && !pkg.local)
      if (used)
        users.set(entry.origin, [
          `${used.versions.join(', ') || used.ranges.join(', ') || 'version unknown'} (${used.count} uses in ${used.files} files)`,
        ])
    }
  for (const item of versions)
    for (const origin of item.usedBy) if (!users.has(origin)) users.set(origin, [item.version])
  if (users.size) {
    lines.push(`- Used by ${users.size} repositor${users.size === 1 ? 'y' : 'ies'}:`)
    for (const [origin, detail] of [...users].toSorted(([a], [b]) => a.localeCompare(b)))
      lines.push(
        `  - ${code(origin)}${origin === query.repo ? ' (yours)' : ''}: ${detail.join(', ')}`,
      )
  } else if (!internal.length) lines.push('- No repository you can read uses it.')
  return lines
}

async function vulnerabilitySection(context: DependencyContext, query: Resolved) {
  const newest = new Map<string, Finding[]>()
  for (const run of await context.auditRuns.list({ limit: auditPool })) {
    const key = repoKey(run.repo)
    if (newest.has(key) || !context.canReadAudits(run.repo)) continue
    newest.set(key, [
      ...run.report.findings,
      ...run.report.ignored.map((ignored) => ignored.finding),
    ])
  }
  const advisories = new Map<
    string,
    { finding: Finding; versions: Set<string>; repos: Set<string> }
  >()
  for (const [origin, findings] of newest)
    for (const finding of findings) {
      if (finding.package.name !== query.package) continue
      if (!sameEcosystem(finding.package.ecosystem, query.ecosystem)) continue
      const known = advisories.get(finding.id) ?? {
        finding,
        versions: new Set<string>(),
        repos: new Set<string>(),
      }
      known.versions.add(finding.package.version)
      known.repos.add(origin)
      advisories.set(finding.id, known)
    }
  if (!advisories.size)
    return [
      `- No advisory in the newest audits of ${newest.size} repositor${newest.size === 1 ? 'y' : 'ies'} you can read. Audits scan lockfiles, so versions no repository resolves were not checked.`,
    ]
  const severity = ['critical', 'high', 'medium', 'low', 'unknown']
  return [...advisories.values()]
    .toSorted((a, b) => severity.indexOf(a.finding.severity) - severity.indexOf(b.finding.severity))
    .map(({ finding, versions, repos }) => {
      const affected = [...versions]
      const mark = affected.includes(query.version) ? ` **affects ${query.version}**,` : ''
      return `- ${finding.severity} ${code(finding.id)} ${finding.summary} —${mark} seen at ${affected.join(', ')} in ${[...repos].map(code).join(', ')}; ${finding.fixedVersions.length ? `fixed in ${finding.fixedVersions.join(', ')}` : 'no fix yet'} (${finding.url})`
    })
}

async function licenseSection(context: DependencyContext, query: Resolved) {
  const seen: { origin: string; pkg: LicensedPackage }[] = []
  let policyOfRepo: LicensePolicyData | undefined
  for (const record of await context.analyses.latest({ kind: 'licenses' })) {
    if (!context.canRead(record.repo)) continue
    const parsed = licensesDataSchema.safeParse(record.data)
    if (!parsed.success) continue
    const origin = repoKey(record.repo)
    if (origin === query.repo) policyOfRepo = parsed.data.policy
    for (const pkg of parsed.data.packages)
      if (pkg.name === query.package && sameEcosystem(pkg.ecosystem, query.ecosystem))
        seen.push({ origin, pkg })
  }
  if (!seen.length)
    return [
      '- No license scan of a repository you can read lists it; check the registry before adding it.',
    ]
  const byVersion = new Map<string, { licenses: string; verdicts: Map<string, string[]> }>()
  for (const { origin, pkg } of seen) {
    const item = byVersion.get(pkg.version) ?? {
      licenses: pkg.licenses.join(' AND ') || 'unknown',
      verdicts: new Map<string, string[]>(),
    }
    item.verdicts.set(pkg.verdict, [...(item.verdicts.get(pkg.verdict) ?? []), origin])
    byVersion.set(pkg.version, item)
  }
  const lines = [...byVersion].map(
    ([version, item]) =>
      `- ${version}: ${item.licenses} — ${[...item.verdicts].map(([verdict, origins]) => `${verdict} in ${origins.map(code).join(', ')}`).join('; ')}`,
  )
  const inRepo = seen.some(({ origin }) => origin === query.repo)
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

const targetLabel = (origin: string, target: BundleTarget) =>
  `${code(origin)} ${target.source === 'build' ? `build ${code(target.name)}` : `package ${target.name}${target.version ? `@${target.version}` : ''}`}`

async function bundleSection(context: DependencyContext, query: Resolved) {
  if (query.ecosystem !== 'npm') return []
  const lines: string[] = []
  for (const record of await context.analyses.latest({ kind: 'bundle' })) {
    if (!context.canRead(record.repo) || !isBundleAnalysisData(record.data)) continue
    for (const target of bundleTargets(record.data)) {
      const data = target.data
      const pkg = data?.packages.find((item) => item.name === query.package)
      if (!data || !pkg) continue
      const total = totalSizes(data).gzip
      const share = total ? ` (${((pkg.gzip / total) * 100).toFixed(1)}% of ${kb(total)})` : ''
      lines.push(
        `- ${targetLabel(repoKey(record.repo), target)}: ${kb(pkg.gzip)} gzip${share}, ${pkg.versions.join(', ') || 'version unknown'}, in ${pkg.entrypoints.length} entrypoint${pkg.entrypoints.length === 1 ? '' : 's'}`,
      )
    }
  }
  return lines.length
    ? lines
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
