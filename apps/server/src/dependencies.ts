import { type AuditFindingMetric, type AuditMetrics, auditAnalysis } from '@holtkeeper/analyzers'
import type {
  DependencyAdvisory,
  DependencyBundleShare,
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
import { type LibraryUse, libraryOfModule, majorsBehind } from '@holtkeeper/libraries'
import {
  type LicensePolicyData,
  type LicensedPackage,
  type LicensesMetrics,
  type PackageVerdict,
  compareVerdict,
  licensesDataSchema,
} from '@holtkeeper/licenses'
import { type RenovateMetrics, isBroken, renovateDataSchema } from '@holtkeeper/renovate'
import type { AnalysisHead, AnalysisStore, LibraryEcosystem, LibraryRef } from '@holtkeeper/store'
import type { Severity } from '@holtkeeper/vuln'

import { latestHeadsWithMetrics } from './analyses.ts'

const repoKey = (repo: RepoRef) => `${repo.forge}:${repo.path}`

/** `<ecosystem>:<name>` of a library; Go modules join their library without the `/vN` suffix. */
export const libraryKeyOf = (ref: LibraryRef) =>
  `${ref.ecosystem}:${ref.ecosystem === 'Go' ? libraryOfModule(ref.name) : ref.name}`

const ecosystemOf = (value: string): LibraryEcosystem | undefined =>
  value === 'npm' ? 'npm' : value.toLowerCase() === 'go' ? 'Go' : undefined

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

/** One advisory sighting in one repository, as `advisoriesByLibrary` groups it. */
export type AdvisorySighting = Pick<
  AuditFindingMetric,
  'id' | 'severity' | 'summary' | 'url' | 'fixedIn' | 'package' | 'ecosystem' | 'version'
>

/**
 * Every finding (allowlisted ones too) of the newest main-line `audit` record of each repository
 * `canRead` allows, by `forge:path`, from stored metrics (computed at read time for records stored
 * without).
 */
export async function newestAuditFindings(
  analyses: Pick<AnalysisStore, 'latest' | 'latestHeads' | 'heads' | 'get'>,
  canRead: (repo: RepoRef) => boolean,
): Promise<Map<string, AdvisorySighting[]>> {
  const heads = await latestHeadsWithMetrics(
    analyses,
    new Map([[auditAnalysis.kind, auditAnalysis]]),
    { kind: auditAnalysis.kind },
  )
  return auditHeadFindings(heads, canRead)
}

/**
 * Every finding (allowlisted ones too) in the stored metrics of the newest main-line `audit` heads
 * of the repositories `canRead` allows, by `forge:path`.
 */
export function auditHeadFindings(
  heads: readonly AnalysisHead[],
  canRead: (repo: RepoRef) => boolean,
): Map<string, AdvisorySighting[]> {
  const result = new Map<string, AdvisorySighting[]>()
  for (const head of heads) {
    const metrics = head.metrics
    if (!canRead(head.repo) || !metrics || !('advisories' in metrics)) continue
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by auditMetrics
    const { advisories } = metrics as AuditMetrics
    if (Array.isArray(advisories)) result.set(repoKey(head.repo), advisories)
  }
  return result
}

const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown']

/** Advisories of `findings` by library key, worst first. */
export function advisoriesByLibrary(
  findings: ReadonlyMap<string, readonly AdvisorySighting[]>,
): Map<string, DependencyAdvisory[]> {
  const byLibrary = new Map<
    string,
    Map<string, { finding: AdvisorySighting; versions: Set<string>; repos: Set<string> }>
  >()
  for (const [origin, list] of findings)
    for (const finding of list) {
      const ecosystem = ecosystemOf(finding.ecosystem)
      if (!ecosystem) continue
      const key = libraryKeyOf({ ecosystem, name: finding.package })
      const advisories = byLibrary.get(key) ?? new Map()
      const known = advisories.get(finding.id) ?? {
        finding,
        versions: new Set<string>(),
        repos: new Set<string>(),
      }
      known.versions.add(finding.version)
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
          fixedVersions: finding.fixedIn,
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

/** License expressions and the worst verdict of one library over a fleet's license scans. */
export interface LibraryLicenseState {
  licenses: string[]
  verdict: PackageVerdict
}

/**
 * Licenses and worst verdict of every library, read from the stored metrics of the `licenses`
 * heads `canRead` allows; heads stored without per-package metrics add nothing.
 */
export function licenseStates(
  heads: readonly AnalysisHead[],
  canRead: (repo: RepoRef) => boolean,
): Map<string, LibraryLicenseState> {
  const states = new Map<string, LibraryLicenseState>()
  for (const head of heads) {
    if (head.kind !== 'licenses' || !canRead(head.repo)) continue
    const metrics: Partial<LicensesMetrics> | undefined = head.metrics
    const packages = metrics?.byPackage
    for (const [pkgKey, pkg] of Object.entries(packages ?? {})) {
      const separator = pkgKey.indexOf(':')
      const ecosystem = ecosystemOf(pkgKey.slice(0, separator))
      if (!ecosystem) continue
      const key = libraryKeyOf({ ecosystem, name: pkgKey.slice(separator + 1) })
      const known = states.get(key)
      if (!known) {
        states.set(key, { licenses: pkg.licenses, verdict: pkg.verdict })
        continue
      }
      known.licenses = [...new Set([...known.licenses, ...pkg.licenses])].toSorted()
      if (compareVerdict(pkg.verdict, known.verdict) < 0) known.verdict = pkg.verdict
    }
  }
  return states
}

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

/**
 * Renovate's state of every library touched by an open merge request, read from the stored
 * metrics of the `renovate` heads `canRead` allows: `broken` when any of them is broken.
 */
export function renovateStates(
  heads: readonly AnalysisHead[],
  canRead: (repo: RepoRef) => boolean,
): Map<string, DependencyRenovateState> {
  const states = new Map<string, DependencyRenovateState>()
  for (const head of heads) {
    if (head.kind !== 'renovate' || !canRead(head.repo)) continue
    const metrics: Partial<RenovateMetrics> | undefined = head.metrics
    const pending = metrics?.pending
    for (const [updateKey, state] of Object.entries(pending ?? {})) {
      const separator = updateKey.indexOf(':')
      const ecosystem = managerEcosystem(updateKey.slice(0, separator))
      if (!ecosystem) continue
      const key = libraryKeyOf({ ecosystem, name: updateKey.slice(separator + 1) })
      if (states.get(key) !== 'broken') states.set(key, state)
    }
  }
  return states
}

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

/** `sightings` of one library, without the library sets. */
export const mergeRequestsOf = (
  sightings: readonly RenovateSighting[],
  key: string,
): DependencyMergeRequest[] =>
  sightings
    .filter((sighting) => sighting.libraries.has(key))
    .map(({ libraries: _libraries, ...rest }) => rest)
