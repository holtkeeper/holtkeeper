import type {
  DependencyAdvisory,
  DependencyBundleShare,
  DependencyDecision,
  DependencyLicense,
  DependencyMergeRequest,
  DependencyRenovateState,
  DependencyVersionSpread,
} from '@holtkeeper/api'
import {
  type BundleTarget,
  bundleTargets,
  isBundleAnalysisData,
  totalSizes,
} from '@holtkeeper/bundles'
import { compareVersions } from '@holtkeeper/depgraph'
import type { RepoRef } from '@holtkeeper/forge'
import { withoutSuperseded } from '@holtkeeper/knowledge'
import { type LibraryUse, libraryOfModule, majorsBehind } from '@holtkeeper/libraries'
import {
  type LicensePolicyData,
  type LicensedPackage,
  licensesDataSchema,
} from '@holtkeeper/licenses'
import { isBroken, renovateDataSchema } from '@holtkeeper/renovate'
import type {
  AnalysisStore,
  AuditRunStore,
  KnowledgeEntry,
  KnowledgeStore,
  LibraryEcosystem,
  LibraryRef,
} from '@holtkeeper/store'
import type { Finding, Severity } from '@holtkeeper/vuln'

const repoKey = (repo: RepoRef) => `${repo.forge}:${repo.path}`

/** `<ecosystem>:<name>` of a library; Go modules join their library without the `/vN` suffix. */
export const libraryKeyOf = (ref: LibraryRef) =>
  `${ref.ecosystem}:${ref.ecosystem === 'Go' ? libraryOfModule(ref.name) : ref.name}`

const ecosystemOf = (value: string): LibraryEcosystem | undefined =>
  value === 'npm' ? 'npm' : value.toLowerCase() === 'go' ? 'Go' : undefined

const sameLibrary = (ref: LibraryRef, ecosystem: string, name: string) => {
  const other = ecosystemOf(ecosystem)
  return other !== undefined && libraryKeyOf({ ecosystem: other, name }) === libraryKeyOf(ref)
}

const subjectKey = (subject: string | undefined) => {
  const separator = subject?.indexOf(':') ?? -1
  if (!subject || separator < 1) return undefined
  const ecosystem = ecosystemOf(subject.slice(0, separator))
  return ecosystem && libraryKeyOf({ ecosystem, name: subject.slice(separator + 1) })
}

/** Uses of one library grouped by repository, versions lowest first. */
export interface LibraryUsers {
  ref: LibraryRef
  repos: Map<string, string[]>
}

/** `uses` grouped into libraries by `libraryKeyOf`, repositories and versions sorted. */
export function groupUses(uses: readonly LibraryUse[]): Map<string, LibraryUsers> {
  const result = new Map<string, LibraryUsers>()
  for (const use of uses) {
    const key = libraryKeyOf(use)
    const ref: LibraryRef = {
      ecosystem: use.ecosystem,
      name: use.ecosystem === 'Go' ? libraryOfModule(use.name) : use.name,
    }
    const entry = result.get(key) ?? { ref, repos: new Map<string, string[]>() }
    const versions = entry.repos.get(use.repo) ?? []
    if (!versions.includes(use.version)) versions.push(use.version)
    entry.repos.set(use.repo, versions)
    result.set(key, entry)
  }
  for (const entry of result.values())
    entry.repos = new Map(
      [...entry.repos]
        .map(([repo, versions]) => [repo, versions.toSorted(compareVersions)] as const)
        .toSorted(([a], [b]) => a.localeCompare(b)),
    )
  return result
}

/** Repositories per version, lowest version first, with how far each is behind `latest`. */
export function versionSpread(
  users: LibraryUsers,
  latest: string | undefined,
): DependencyVersionSpread[] {
  const counts = new Map<string, number>()
  for (const versions of users.repos.values())
    for (const version of versions) counts.set(version, (counts.get(version) ?? 0) + 1)
  return [...counts]
    .toSorted(([a], [b]) => compareVersions(a, b))
    .map(([version, repos]) => ({
      version,
      repos,
      majorsBehind: latest ? majorsBehind(version, latest) : 0,
    }))
}

/** Audit runs read to find the newest one of each repository. */
const AUDIT_POOL = 1000

/** Every finding (ignored ones too) of the newest audit run of each repository `canRead` allows. */
export async function newestAuditFindings(
  auditRuns: Pick<AuditRunStore, 'list'>,
  canRead: (repo: RepoRef) => boolean,
): Promise<Map<string, Finding[]>> {
  const newest = new Map<string, Finding[]>()
  for (const run of await auditRuns.list({ limit: AUDIT_POOL })) {
    const key = repoKey(run.repo)
    if (newest.has(key) || !canRead(run.repo)) continue
    newest.set(key, [
      ...run.report.findings,
      ...run.report.ignored.map((ignored) => ignored.finding),
    ])
  }
  return newest
}

const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown']

/** Advisories of `findings` by library key, worst first. */
export function advisoriesByLibrary(
  findings: ReadonlyMap<string, Finding[]>,
): Map<string, DependencyAdvisory[]> {
  const byLibrary = new Map<
    string,
    Map<string, { finding: Finding; versions: Set<string>; repos: Set<string> }>
  >()
  for (const [origin, list] of findings)
    for (const finding of list) {
      const ecosystem = ecosystemOf(finding.package.ecosystem)
      if (!ecosystem) continue
      const key = libraryKeyOf({ ecosystem, name: finding.package.name })
      const advisories = byLibrary.get(key) ?? new Map()
      const known = advisories.get(finding.id) ?? {
        finding,
        versions: new Set<string>(),
        repos: new Set<string>(),
      }
      known.versions.add(finding.package.version)
      known.repos.add(origin)
      advisories.set(finding.id, known)
      byLibrary.set(key, advisories)
    }
  return new Map(
    [...byLibrary].map(([key, advisories]) => [
      key,
      [...advisories.values()]
        .map(({ finding, versions, repos }): DependencyAdvisory => ({
          id: finding.id,
          severity: finding.severity,
          summary: finding.summary,
          url: finding.url,
          fixedVersions: finding.fixedVersions,
          versions: [...versions].toSorted(compareVersions),
          repos: [...repos].toSorted(),
        }))
        .toSorted(
          (a, b) =>
            severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) ||
            a.id.localeCompare(b.id),
        ),
    ]),
  )
}

/** The worst severity of `advisories`. */
export const worstSeverity = (advisories: readonly DependencyAdvisory[]) =>
  advisories
    .map((advisory) => advisory.severity)
    .toSorted((a, b) => severityOrder.indexOf(a) - severityOrder.indexOf(b))[0]

/** One package of a license scan and the repository whose scan lists it. */
export interface LicenseSighting {
  origin: string
  pkg: LicensedPackage
}

/**
 * Packages of the newest license scan of each repository `canRead` allows, by library key, and
 * the license policy of each scanned repository by `forge:path`.
 */
export async function licenseSightings(
  analyses: Pick<AnalysisStore, 'latest'>,
  canRead: (repo: RepoRef) => boolean,
): Promise<{
  libraries: Map<string, LicenseSighting[]>
  policies: Map<string, LicensePolicyData>
}> {
  const libraries = new Map<string, LicenseSighting[]>()
  const policies = new Map<string, LicensePolicyData>()
  for (const record of await analyses.latest({ kind: 'licenses' })) {
    if (!canRead(record.repo)) continue
    const parsed = licensesDataSchema.safeParse(record.data)
    if (!parsed.success) continue
    const origin = repoKey(record.repo)
    policies.set(origin, parsed.data.policy)
    for (const pkg of parsed.data.packages) {
      const ecosystem = ecosystemOf(pkg.ecosystem)
      if (!ecosystem) continue
      const key = libraryKeyOf({ ecosystem, name: pkg.name })
      libraries.set(key, [...(libraries.get(key) ?? []), { origin, pkg }])
    }
  }
  return { libraries, policies }
}

const verdictOrder = ['denied', 'unlisted', 'unknown', 'allowed', 'internal', 'ignored']

/** The worst verdict of `sightings`. */
export const worstVerdict = (sightings: readonly LicenseSighting[]) =>
  sightings
    .map((sighting) => sighting.pkg.verdict)
    .toSorted((a, b) => verdictOrder.indexOf(a) - verdictOrder.indexOf(b))[0]

/** License expressions and verdicts of `sightings`, one entry per version, lowest first. */
export function licensesOf(sightings: readonly LicenseSighting[]): DependencyLicense[] {
  const byVersion = new Map<string, { licenses: string[]; verdicts: Map<string, string[]> }>()
  for (const { origin, pkg } of sightings) {
    const item = byVersion.get(pkg.version) ?? { licenses: pkg.licenses, verdicts: new Map() }
    const repos = item.verdicts.get(pkg.verdict) ?? []
    if (!repos.includes(origin)) repos.push(origin)
    item.verdicts.set(pkg.verdict, repos)
    byVersion.set(pkg.version, item)
  }
  return [...byVersion]
    .toSorted(([a], [b]) => compareVersions(a, b))
    .map(([version, item]) => ({
      version,
      licenses: item.licenses,
      verdicts: [...item.verdicts].map(([verdict, repos]) => ({
        verdict,
        repos: repos.toSorted(),
      })),
    }))
}

const targetLabel = (target: BundleTarget) =>
  target.source === 'build'
    ? `build ${target.name}`
    : `package ${target.name}${target.version ? `@${target.version}` : ''}`

/** The library's gzip share of every measured bundle target of the repositories `canRead` allows. */
export async function bundleShares(
  analyses: Pick<AnalysisStore, 'latest'>,
  canRead: (repo: RepoRef) => boolean,
  name: string,
): Promise<DependencyBundleShare[]> {
  const result: DependencyBundleShare[] = []
  for (const record of await analyses.latest({ kind: 'bundle' })) {
    if (!canRead(record.repo) || !isBundleAnalysisData(record.data)) continue
    for (const target of bundleTargets(record.data)) {
      const data = target.data
      const pkg = data?.packages.find((item) => item.name === name)
      if (!data || !pkg) continue
      const total = totalSizes(data).gzip
      result.push({
        repo: repoKey(record.repo),
        target: targetLabel(target),
        gzip: pkg.gzip,
        ...(total ? { total } : {}),
        versions: pkg.versions,
        entrypoints: pkg.entrypoints.length,
      })
    }
  }
  return result
}

/** A Renovate merge request with the libraries its updates touch, by library key. */
interface RenovateSighting extends DependencyMergeRequest {
  libraries: Set<string>
}

const managerEcosystem = (manager: string): LibraryEcosystem | undefined =>
  manager === 'gomod' ? 'Go' : ['npm', 'pnpm', 'yarn', 'bun'].includes(manager) ? 'npm' : undefined

/** Open Renovate merge requests of the newest record of each repository `canRead` allows. */
export async function renovateMergeRequests(
  analyses: Pick<AnalysisStore, 'latest'>,
  canRead: (repo: RepoRef) => boolean,
): Promise<RenovateSighting[]> {
  const result: RenovateSighting[] = []
  for (const record of await analyses.latest({ kind: 'renovate' })) {
    if (!canRead(record.repo)) continue
    const data = renovateDataSchema.safeParse(record.data).data
    if (!data) continue
    for (const mr of data.mergeRequests) {
      if (mr.state !== 'open') continue
      const updates = data.updates.filter((update) => update.mergeRequest === mr.id)
      const libraries = new Set<string>()
      for (const update of updates) {
        const ecosystem = managerEcosystem(update.manager)
        if (ecosystem) libraries.add(libraryKeyOf({ ecosystem, name: update.dependency }))
      }
      if (!libraries.size) continue
      const next = updates.find((update) => update.next)?.next
      result.push({
        repo: repoKey(record.repo),
        id: mr.id,
        ...(mr.url ? { url: mr.url } : {}),
        title: mr.title,
        status: isBroken(mr) ? 'broken' : mr.draft ? 'draft' : 'open',
        ...(next ? { next } : {}),
        libraries,
      })
    }
  }
  return result
}

/** Renovate's state for one library over `sightings`. */
export function renovateState(
  sightings: readonly RenovateSighting[],
  key: string,
): DependencyRenovateState {
  const own = sightings.filter((sighting) => sighting.libraries.has(key))
  if (own.some((sighting) => sighting.status === 'broken')) return 'broken'
  return own.length ? 'open' : 'none'
}

/** `sightings` of one library, without the library sets. */
export const mergeRequestsOf = (
  sightings: readonly RenovateSighting[],
  key: string,
): DependencyMergeRequest[] =>
  sightings
    .filter((sighting) => sighting.libraries.has(key))
    .map(({ libraries: _libraries, ...rest }) => rest)

/**
 * Accepted knowledge entries about the library (as their `subject` or among their packages) that
 * `canRead` allows, superseded ones left out: entries people wrote first, then agents' accepted
 * proposals, newest first within each.
 */
export async function libraryDecisions(
  knowledge: Pick<KnowledgeStore, 'list'>,
  access: {
    /** Entries readable as the caller's own team's. */
    canRead: (entry: KnowledgeEntry) => boolean
    /** Entries readable only as another team's `shared` entry. */
    canReadShared?: (entry: KnowledgeEntry) => boolean
    ownerOf: (entry: KnowledgeEntry) => string[]
  },
  ref: LibraryRef,
): Promise<DependencyDecision[]> {
  const shared = (entry: KnowledgeEntry) =>
    !access.canRead(entry) &&
    entry.visibility === 'shared' &&
    access.canReadShared?.(entry) === true
  const key = libraryKeyOf(ref)
  const entries = await knowledge.list({ status: 'accepted' })
  const hits = entries
    .filter(
      (entry) =>
        (subjectKey(entry.subject) === key ||
          (entry.packages ?? []).some((pkg) => sameLibrary(ref, pkg.ecosystem, pkg.name))) &&
        (access.canRead(entry) || shared(entry)),
    )
    .map((entry) => ({ entry, score: 0 }))
  return withoutSuperseded(hits)
    .map(({ entry }) => entry)
    .toSorted(
      (a, b) =>
        Number(a.source === 'agent') - Number(b.source === 'agent') ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      source: entry.source,
      author: entry.author,
      updatedAt: entry.updatedAt,
      owner: access.ownerOf(entry),
      shared: shared(entry),
    }))
}
