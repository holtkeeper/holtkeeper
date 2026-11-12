import { type RepoTarget, scopeCoversRepo } from '@holtkeeper/access'
import { analysisMetrics } from '@holtkeeper/analyzer'
import type {
  LicenseDelta,
  LicensePolicySummary,
  LicenseVerdictName,
  LicenseViolation,
  LicensesOverview,
  LicensesRepoRow,
} from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import {
  type FlaggedPackages,
  type FlaggedVerdict,
  type LicensesMetrics,
  compareVerdict,
  licensePresets,
  licensesOptionsSchema,
} from '@holtkeeper/licenses'
import type { AnalysisKind } from '@holtkeeper/report'
import type { AnalysisHead, AnalysisStore, SettingEntry, SettingStore } from '@holtkeeper/store'

import { LINE_SCAN, latestHeadsWithMetrics, mainLineRecords } from './analyses.ts'
import { repoKey } from './context.ts'
import type { FleetCache } from './fleet-cache.ts'
import { orgEntry } from './setting-rules.ts'

const KIND = 'licenses'
const SETTING = `analyzers.${KIND}`
const WEEK = 7 * 86_400_000
const SLACK = 3_600_000

/** Where a licenses overview reads from. */
export interface LicensesSource {
  analyses: Pick<AnalysisStore, 'latest' | 'latestHeads' | 'heads' | 'get'>
  settings: Pick<SettingStore, 'list'>
  /** Analysis kinds the server knows; the `licenses` kind computes metrics records lack. */
  // oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
  kinds: ReadonlyMap<string, AnalysisKind<any, any>>
  /** A repository with its config groups. */
  targetOf: (repo: RepoRef) => RepoTarget
  /** Keeps answers while the latest records and the policy stay the same. */
  cache?: FleetCache
}

const flaggedVerdicts: FlaggedVerdict[] = ['denied', 'unlisted', 'unknown']

const isCurrent = (metrics: unknown): metrics is LicensesMetrics =>
  typeof metrics === 'object' &&
  metrics !== null &&
  ['verdicts', 'flagged', 'flaggedDetails', 'licenses', 'licenseFile', 'allowedLicenses'].every(
    (field) => field in metrics,
  )

async function metricsOf(
  source: LicensesSource,
  head: AnalysisHead,
): Promise<LicensesMetrics | undefined> {
  if (isCurrent(head.metrics)) return head.metrics
  const record = await source.analyses.get(head.id)
  const computed = record && analysisMetrics(source.kinds.get(KIND), record.data)
  return isCurrent(computed) ? computed : undefined
}

async function weekOld(
  source: LicensesSource,
  head: AnalysisHead,
): Promise<AnalysisHead | undefined> {
  const before = new Date(Date.parse(head.createdAt) - WEEK + SLACK).toISOString()
  const line = await source.analyses.heads({
    repo: head.repo,
    kind: KIND,
    before,
    limit: LINE_SCAN,
  })
  return mainLineRecords(
    line.filter((candidate) => candidate.ref === head.ref),
    1,
  )[0]
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set([...a, ...b]).size === a.length

function policySummary(
  entries: readonly SettingEntry[],
  targets: RepoTarget[],
): LicensePolicySummary {
  const org = orgEntry(entries, SETTING)
  const parsed = licensesOptionsSchema.safeParse(
    org && typeof org.value === 'object' && org.value !== null ? org.value : {},
  )
  const options = parsed.success ? parsed.data : licensesOptionsSchema.parse({})
  const preset = licensePresets.find((candidate) => {
    const value = licensesOptionsSchema.parse(candidate.options)
    return (
      sameSet(value.allow, options.allow) &&
      sameSet(value.deny, options.deny) &&
      value.unknown === options.unknown &&
      value.requireProjectLicense === options.requireProjectLicense
    )
  })
  const overrides = entries.filter(
    (entry) =>
      entry.scope.all !== true && targets.some((target) => scopeCoversRepo(entry.scope, target)),
  ).length
  const summary: LicensePolicySummary = {
    ...(preset ? { preset: preset.label } : {}),
    allow: options.allow,
    deny: options.deny,
    ignore: options.ignore,
    review: options.review,
    unknown: options.unknown,
    devDependencies: options.devDependencies,
    exceptions: options.exceptions,
    requireProjectLicense: options.requireProjectLicense,
    overrides,
    ...(org ? { updatedAt: org.updatedAt } : {}),
    ...(org?.updatedBy ? { updatedBy: org.updatedBy } : {}),
  }
  return summary
}

interface Scan {
  head: AnalysisHead
  target: RepoTarget
  metrics: LicensesMetrics
}

/** Per-verdict counts; records stored before `excepted` existed count zero. */
const verdictCounts = (metrics: LicensesMetrics): Record<LicenseVerdictName, number> => {
  const counts: Record<LicenseVerdictName, number> = { ...metrics.verdicts }
  const all: Record<string, number> = counts
  all.excepted ??= 0
  return counts
}

function repoRow(scan: Scan): LicensesRepoRow {
  const { head, target, metrics } = scan
  return {
    repo: repoKey(head.repo),
    groups: target.groups,
    analysisId: head.id,
    createdAt: head.createdAt,
    packages: metrics.packages - metrics.verdicts.internal,
    verdicts: verdictCounts(metrics),
    licenseFile: metrics.licenseFile,
  }
}

function unionFlagged(all: readonly FlaggedPackages[]): Record<FlaggedVerdict, Set<string>> {
  const worst = new Map<string, FlaggedVerdict>()
  for (const flagged of all)
    for (const verdict of flaggedVerdicts)
      for (const key of flagged[verdict]) {
        const known = worst.get(key)
        if (!known || compareVerdict(verdict, known) < 0) worst.set(key, verdict)
      }
  const sets: Record<FlaggedVerdict, Set<string>> = {
    denied: new Set(),
    unlisted: new Set(),
    unknown: new Set(),
  }
  for (const [key, verdict] of worst) sets[verdict].add(key)
  return sets
}

const delta = (now: Set<string>, before: Set<string>): LicenseDelta => ({
  added: [...now].filter((key) => !before.has(key)).length,
  resolved: [...before].filter((key) => !now.has(key)).length,
})

async function weeklyDeltas(
  source: LicensesSource,
  scans: readonly Scan[],
): Promise<LicensesOverview['deltas']> {
  const pairs = await Promise.all(
    scans.map(async (scan) => {
      const older = await weekOld(source, scan.head)
      const metrics = older && (await metricsOf(source, older))
      return older && metrics ? { scan, older, metrics } : undefined
    }),
  )
  const compared = pairs.filter((pair) => pair !== undefined)
  if (!compared.length) return undefined
  const now = unionFlagged(compared.map((pair) => pair.scan.metrics.flagged))
  const before = unionFlagged(compared.map((pair) => pair.metrics.flagged))
  return {
    since: compared.map((pair) => pair.older.createdAt).toSorted()[0] ?? '',
    denied: delta(now.denied, before.denied),
    review: delta(now.unlisted, before.unlisted),
    unknown: delta(now.unknown, before.unknown),
  }
}

interface ViolationDraft {
  package: string
  ecosystem: string
  versions: Set<string>
  licenses: Set<string>
  verdict: FlaggedVerdict
  culprits: Set<string>
  dev: boolean
  repos: Map<string, string[]>
}

function violationsOf(scans: readonly Scan[]): LicenseViolation[] {
  const drafts = new Map<string, ViolationDraft>()
  for (const scan of scans)
    for (const [key, pkg] of Object.entries(scan.metrics.flaggedDetails)) {
      const draft = drafts.get(key) ?? {
        package: pkg.name,
        ecosystem: pkg.ecosystem,
        versions: new Set<string>(),
        licenses: new Set<string>(),
        verdict: pkg.verdict,
        culprits: new Set<string>(),
        dev: true,
        repos: new Map<string, string[]>(),
      }
      for (const version of pkg.versions) draft.versions.add(version)
      for (const license of pkg.licenses) draft.licenses.add(license)
      for (const culprit of pkg.culprits) draft.culprits.add(culprit)
      if (compareVerdict(pkg.verdict, draft.verdict) < 0) draft.verdict = pkg.verdict
      if (!pkg.dev) draft.dev = false
      draft.repos.set(repoKey(scan.head.repo), scan.target.groups)
      drafts.set(key, draft)
    }
  return [...drafts.values()]
    .map((draft): LicenseViolation => ({
      package: draft.package,
      ecosystem: draft.ecosystem,
      versions: [...draft.versions].toSorted(),
      licenses: [...draft.licenses].toSorted(),
      verdict: draft.verdict,
      culprits: [...draft.culprits].toSorted(),
      dev: draft.dev,
      repos: [...draft.repos]
        .map(([repo, groups]) => ({ repo, groups }))
        .toSorted((a, b) => a.repo.localeCompare(b.repo)),
    }))
    .toSorted(
      (a, b) =>
        compareVerdict(a.verdict, b.verdict) ||
        b.repos.length - a.repos.length ||
        a.package.localeCompare(b.package),
    )
}

async function scansOf(source: LicensesSource, heads: readonly AnalysisHead[]): Promise<Scan[]> {
  const scans = await Promise.all(
    heads.map(async (head) => {
      const metrics = await metricsOf(source, head)
      return metrics ? { head, target: source.targetOf(head.repo), metrics } : undefined
    }),
  )
  return scans.filter((scan) => scan !== undefined)
}

async function buildOverview(
  source: LicensesSource,
  heads: readonly AnalysisHead[],
  settings: readonly SettingEntry[] | undefined,
): Promise<LicensesOverview> {
  const scans = await scansOf(source, heads)
  const violations = violationsOf(scans)
  const deltas = await weeklyDeltas(source, scans)
  const rows = scans
    .map(repoRow)
    .toSorted(
      (a, b) =>
        b.verdicts.denied - a.verdicts.denied ||
        b.verdicts.unlisted - a.verdicts.unlisted ||
        b.verdicts.unknown - a.verdicts.unknown ||
        a.repo.localeCompare(b.repo),
    )
  const mix = new Map<string, number>()
  const allowed = new Set<string>()
  for (const { metrics } of scans) {
    for (const [license, count] of Object.entries(metrics.licenses))
      mix.set(license, (mix.get(license) ?? 0) + count)
    for (const license of metrics.allowedLicenses) allowed.add(license)
  }
  const flagged = unionFlagged(scans.map((scan) => scan.metrics.flagged))
  return {
    kpi: {
      packages: rows.reduce((total, row) => total + row.packages, 0),
      repos: rows.length,
      denied: flagged.denied.size,
      review: flagged.unlisted.size,
      unknown: flagged.unknown.size,
      licenses: mix.size,
      allowedLicenses: allowed.size,
      internal: rows.reduce((total, row) => total + row.verdicts.internal, 0),
      missingLicenseFile: rows.filter((row) => row.licenseFile === 'missing').length,
    },
    mix: [...mix]
      .map(([license, packages]) => ({ license, packages }))
      .toSorted((a, b) => b.packages - a.packages || a.license.localeCompare(b.license)),
    violations,
    repos: rows,
    ...(settings && {
      policy: policySummary(
        settings,
        scans.map((scan) => scan.target),
      ),
    }),
    ...(deltas ? { deltas } : {}),
  }
}

/**
 * The newest license scan of every repository `canRead` allows (the caller's `analyses:read`):
 * totals, license mix, violations, a row per repository, the organization's license policy (only
 * when `canReadPolicy`, the caller's `settings:read` on the organization scope) and changes over
 * the past week against each repository's main-line scan at least about seven days older than its
 * newest. Everything is read from stored metrics; only records stored before a metrics field
 * existed have their data read. Packages and the mix count each repository's packages, so a
 * package two repositories use counts twice; denied, review and unknown count distinct packages.
 * With `source.cache`, answers are kept while the newest records, the readable repositories, the
 * policy access and the `analyzers.licenses` entries stay the same.
 */
export async function licensesOverview(
  source: LicensesSource,
  canRead: (repo: RepoTarget) => boolean,
  canReadPolicy: boolean,
): Promise<LicensesOverview> {
  const [all, settings] = await Promise.all([
    latestHeadsWithMetrics(source.analyses, source.kinds, { kind: KIND }),
    source.settings.list(SETTING),
  ])
  const heads = all.filter((head) => canRead(source.targetOf(head.repo)))
  const build = () => buildOverview(source, heads, canReadPolicy ? settings : undefined)
  if (!source.cache) return build()
  const policy = canReadPolicy
    ? settings
        .map((entry) => `${entry.id}@${entry.updatedAt}`)
        .toSorted()
        .join(',')
    : 'hidden'
  return source.cache.read(
    {
      endpoint: `licenses?policy=${policy}`,
      analysisIds: heads.map((head) => head.id),
      repos: heads.map((head) => repoKey(head.repo)),
    },
    build,
  )
}
