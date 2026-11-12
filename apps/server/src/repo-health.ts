import type { Action, Principal, RepoTarget } from '@holtkeeper/access'
import { metricsOf } from '@holtkeeper/analyzer'
import { auditAnalysis } from '@holtkeeper/analyzers'
import { summarizeRun } from '@holtkeeper/api'
import type {
  AuditRunSummary,
  HealthTone,
  ReleaseCard,
  RepoFreshness,
  RepoHealthCell,
  RepoHealthCellKey,
  RepoHealthCells,
  RepoHealthStatus,
} from '@holtkeeper/api'
import { bundleAnalysis, bundleBudgetsSchema, judgeTarget } from '@holtkeeper/bundles'
import { ciJobsAnalysis } from '@holtkeeper/ci-jobs'
import { coverageAnalysis, coverageTargetOf } from '@holtkeeper/coverage'
import type { RepoRef } from '@holtkeeper/forge'
import { licensesAnalysis } from '@holtkeeper/licenses'
import { renovateAnalysis } from '@holtkeeper/renovate'
import { formatBytes } from '@holtkeeper/report'
import { settingCascades } from '@holtkeeper/settings'
import type { AnalysisHead, Job, SettingEntry } from '@holtkeeper/store'

import { latestHeadsWithMetrics } from './analyses.ts'
import { type ServerDeps, repoKey } from './context.ts'
import { canSee } from './visibility.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** A newest record older than this does not count as current. */
export const STALE_ANALYSIS_DAYS = 14
/** Jobs that ended this long ago or less count for the jobs cell. */
const JOBS_WINDOW_MS = DAY_MS
/** Coverage that fell by this many percentage points or more since the record before warns. */
const COVERAGE_DROP_WARN = 1
/** Bundle growth against the record before, as a share, from which the cell warns. */
const BUNDLE_GROWTH_WARN = 0.1
/** Outdated dependencies from which the cell warns even without major updates. */
const OUTDATED_WARN = 10

/** The permission each cell needs on the repository. */
const cellActions: Record<RepoHealthCellKey, Action> = {
  security: 'audits:read',
  dependencies: 'analyses:read',
  coverage: 'analyses:read',
  bundles: 'analyses:read',
  jobs: 'analyses:read',
  ci: 'analyses:read',
  licenses: 'analyses:read',
  release: 'releases:read',
}

const cellOrder: RepoHealthCellKey[] = [
  'security',
  'dependencies',
  'coverage',
  'bundles',
  'jobs',
  'ci',
  'licenses',
  'release',
]

/** A repository's health over the cells the caller may read. */
export interface RepoHealth {
  health: RepoHealthStatus
  cells: RepoHealthCells
  /** Absent when the caller may not read analyses. */
  freshness?: RepoFreshness
  lastAnalysedAt?: string
}

/**
 * Everything health is classified from, read once per request: every setting entry, the newest
 * main-line record head per repository and kind (metrics filled in at read time for records stored
 * without), recent jobs newest first, the stored release cards and recent audit runs newest first.
 */
export interface HealthSources {
  now: Date
  settings: readonly SettingEntry[]
  heads: readonly AnalysisHead[]
  jobs: readonly Job[]
  releases: readonly ReleaseCard[]
  /** Audit runs, also those ingested without an `audit` record; none when absent. */
  audits?: readonly AuditRunSummary[]
}

/** Which of the cell permissions the caller holds on one repository. */
export type HealthAccess = (action: Action) => boolean

/** `HealthAccess` of `principal` on `repo`. */
export const principalHealthAccess =
  (principal: Principal, repo: RepoTarget): HealthAccess =>
  (action) =>
    canSee(principal, action, repo)

const cell = (value: string, sub: string, tone: HealthTone): RepoHealthCell => ({
  value,
  sub,
  tone,
})

const noRecord = () => cell('—', 'no record', 'none')

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined

const signed = (value: number, text: string) =>
  value > 0 ? `+${text}` : value < 0 ? `−${text.replace('-', '')}` : `±${text}`

const pointsText = (delta: number) => `${signed(delta, Math.abs(delta).toFixed(1))} pt`

const shortAge = (from: string, now: Date) => {
  const hours = Math.max(0, now.getTime() - Date.parse(from)) / HOUR_MS
  if (hours < 1) return 'now'
  if (hours < 24) return `${Math.floor(hours)}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 60) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

const durationText = (seconds: number) => {
  const rounded = Math.round(seconds)
  const minutes = Math.floor(rounded / 60)
  return minutes ? `${minutes}m ${rounded % 60}s` : `${rounded}s`
}

/** The newest analysis head older than `STALE_ANALYSIS_DAYS` at `now`. */
export const isStale = (head: Pick<AnalysisHead, 'createdAt'>, now: Date) =>
  now.getTime() - Date.parse(head.createdAt) > STALE_ANALYSIS_DAYS * DAY_MS

/** The audit counts of the newer of the `audit` head and the newest audit run. */
function auditCounts(head: AnalysisHead | undefined, run: AuditRunSummary | undefined) {
  if (run && (!head || run.finishedAt > head.createdAt))
    return { severities: run.severities, ignored: run.ignored, expired: run.expiredAllowlist }
  return head && metricsOf(auditAnalysis, head)
}

function securityCell(
  head: AnalysisHead | undefined,
  run: AuditRunSummary | undefined,
): RepoHealthCell {
  const metrics = auditCounts(head, run)
  if (!metrics?.severities) return head ? cell('—', 'no counts', 'none') : noRecord()
  const { critical, high, medium, low, unknown } = metrics.severities
  const ignored = metrics.ignored ?? 0
  const allowlisted = ignored ? [`${ignored} allowlisted`] : []
  if (critical)
    return cell(
      `${critical} critical`,
      [...(high ? [`${high} high`] : []), ...allowlisted].join(' · '),
      'bad',
    )
  if (high) return cell(`${high} high`, allowlisted.join(' · '), 'bad')
  if (metrics.expired)
    return cell('Allowlist expired', plural(metrics.expired, 'entry', 'entries'), 'warn')
  if (medium) return cell(`${medium} medium`, low + unknown ? `${low + unknown} lower` : '', 'warn')
  if (low) return cell(`${low} low`, allowlisted.join(' · '), 'warn')
  if (unknown) return cell(`${unknown} unrated`, allowlisted.join(' · '), 'warn')
  return cell('None', ignored ? `${ignored} allowlisted` : '0 findings', 'ok')
}

const updateKinds = ({ minor, patch }: { minor?: number; patch?: number }) => {
  if (minor && !patch) return 'minor only'
  if (patch && !minor) return 'patch only'
  return 'minor or patch'
}

function dependenciesCell(head: AnalysisHead | undefined): RepoHealthCell {
  const metrics = head && metricsOf(renovateAnalysis, head)
  if (metrics?.outdated === undefined) return head ? cell('—', 'no counts', 'none') : noRecord()
  const { outdated, major, security } = metrics
  if (outdated === 0) return cell('Up to date', '', 'ok')
  if (security)
    return cell(`${outdated} behind`, plural(security, 'security fix', 'security fixes'), 'bad')
  return cell(
    `${outdated} behind`,
    major ? `${major} major` : updateKinds(metrics),
    major || outdated >= OUTDATED_WARN ? 'warn' : 'ok',
  )
}

function coverageCell(head: AnalysisHead | undefined, target: number): RepoHealthCell {
  if (!head) return noRecord()
  const metrics = metricsOf(coverageAnalysis, head)
  if (metrics?.percent === undefined) return cell('—', 'nothing to cover', 'none')
  const value = `${Math.round(metrics.percent)}%`
  if (metrics.percent < target) return cell(value, `below ${target}%`, 'bad')
  if (metrics.delta === undefined) return cell(value, `target ${target}%`, 'ok')
  return cell(
    value,
    pointsText(metrics.delta),
    metrics.delta <= -COVERAGE_DROP_WARN ? 'warn' : 'ok',
  )
}

function bundlesCell(
  head: AnalysisHead | undefined,
  budgets: Record<string, number> | undefined,
): RepoHealthCell {
  if (!head) return noRecord()
  const metrics = metricsOf(bundleAnalysis, head)
  const targets = (metrics?.targets ?? []).filter((target) => target.gzip !== undefined)
  if (!targets.length)
    return metrics?.failed
      ? cell('Failed', plural(metrics.failed, 'target'), 'bad')
      : cell('—', 'no targets', 'none')
  const total = targets.reduce((sum, target) => sum + (target.gzip ?? 0), 0)
  const deltas = targets.flatMap((target) => (target.delta === undefined ? [] : [target.delta]))
  const delta = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) : undefined
  const value = formatBytes(total)
  const verdicts = targets.map((target) => judgeTarget(target, budgets).verdict ?? 'ok')
  const over = verdicts.filter((verdict) => verdict === 'over').length
  if (over) return cell(value, `${plural(over, 'target')} over budget`, 'bad')
  if (metrics?.failed) return cell(value, `${plural(metrics.failed, 'target')} failed`, 'warn')
  const near = verdicts.filter((verdict) => verdict === 'near').length
  if (near) return cell(value, `${plural(near, 'target')} near budget`, 'warn')
  if (delta === undefined) return cell(value, plural(targets.length, 'target'), 'ok')
  const before = total - delta
  const growth = before > 0 ? delta / before : 0
  return growth >= BUNDLE_GROWTH_WARN
    ? cell(value, `+${Math.round(growth * 100)}%`, 'warn')
    : cell(value, signed(delta, formatBytes(Math.abs(delta))), 'ok')
}

function jobsCell(jobs: readonly Job[], now: Date): RepoHealthCell {
  if (!jobs.length) return cell('No jobs', '', 'none')
  const active = jobs.filter((job) => job.status === 'running' || job.status === 'queued')
  const latest = new Map<string, Job>()
  for (const job of jobs) {
    const ended = job.finishedAt ?? job.createdAt
    if (now.getTime() - Date.parse(ended) > JOBS_WINDOW_MS) continue
    if (!latest.has(job.analyzer)) latest.set(job.analyzer, job)
  }
  const ended = [...latest.values()]
  const failed = ended.filter((job) => job.status === 'failed').length
  if (failed) return cell(`${failed} failed`, 'last 24 hours', 'bad')
  const blocked = ended.filter((job) => job.status === 'blocked').length
  if (blocked) return cell(`${blocked} blocked`, 'AI budget', 'warn')
  if (active.some((job) => job.status === 'running'))
    return cell('Running', plural(active.length, 'job'), 'info')
  if (active.length) return cell('Queued', plural(active.length, 'job'), 'info')
  return cell('OK', '', 'ok')
}

function ciCell(head: AnalysisHead | undefined): RepoHealthCell {
  if (!head) return noRecord()
  const metrics = metricsOf(ciJobsAnalysis, head)
  switch (metrics?.status) {
    case 'failing':
      return cell(
        'Failing',
        [
          plural(metrics.failing ?? 0, 'job'),
          ...(metrics.successRate === undefined ? [] : [`${metrics.successRate}% pass`]),
        ].join(' · '),
        'bad',
      )
    case 'flaky':
      return cell('Flaky', plural(metrics.flaky ?? 0, 'flaky job'), 'warn')
    case 'slower':
      return cell(
        'Slower',
        metrics.change === undefined ? '' : `+${Math.round(metrics.change)}% pipeline time`,
        'warn',
      )
    case 'healthy':
      return cell(
        'Passing',
        [
          ...(metrics.median === undefined ? [] : [durationText(metrics.median)]),
          ...(metrics.queue === undefined ? [] : [`queue ${durationText(metrics.queue)}`]),
        ].join(' · '),
        'ok',
      )
    case 'idle':
      return cell('Idle', 'no pipelines', 'none')
    default:
      return cell('—', 'no counts', 'none')
  }
}

function licensesCell(head: AnalysisHead | undefined): RepoHealthCell {
  if (!head) return noRecord()
  const metrics = metricsOf(licensesAnalysis, head)
  if (!metrics?.verdicts) return cell('—', 'no counts', 'none')
  const { denied, unknown, unlisted } = metrics.verdicts
  if (denied)
    return cell(`${denied} denied`, plural(metrics.violations ?? denied, 'violation'), 'bad')
  if (metrics.violations) return cell(plural(metrics.violations, 'violation'), '', 'bad')
  if (unknown + unlisted) return cell(`${unknown + unlisted} to review`, '', 'warn')
  if (metrics.missingProjectLicense) return cell('No license file', '', 'warn')
  return cell('OK', plural(metrics.packages ?? 0, 'package'), 'ok')
}

function releaseCell(card: ReleaseCard | undefined, now: Date): RepoHealthCell {
  if (!card) return cell('Off', 'not set up', 'none')
  if (card.needsAction) {
    if (card.error !== undefined) return cell('Unknown', 'reading failed', 'warn')
    const failed = card.deploy?.environments.find((env) => env.status === 'failed')
    if (failed && card.deploy)
      return cell('Deploy failed', `${card.deploy.tag} · ${failed.name}`, 'bad')
    if (card.stage === 'awaiting-version')
      return cell('Waiting', card.next ? `version ${card.next}` : 'for a version', 'warn')
    if (card.stage === 'proposed')
      return cell('Waiting', card.next ? `${card.next} · acceptance` : 'acceptance', 'warn')
    if (card.stage === 'candidate')
      return cell(
        'Ready',
        card.next
          ? [card.latest?.tag, card.next].filter(Boolean).join(' → ')
          : `${plural(card.unreleased, 'unreleased commit')}${card.unreleasedCapped ? '+' : ''}`,
        'info',
      )
    const ready = card.deploy?.environments.find((env) => env.status === 'ready')
    if (ready && card.deploy) return cell('Ready', `${card.deploy.tag} → ${ready.name}`, 'info')
  }
  if (card.unreleased > 0)
    return cell(
      'Waiting',
      `${plural(card.unreleased, 'commit')}${card.unreleasedCapped ? '+' : ''} unreleased`,
      'warn',
    )
  const { latest } = card
  if (!latest) return cell('Released', '', 'ok')
  return cell(
    'Released',
    latest.date ? `${latest.tag} · ${shortAge(latest.date, now)}` : latest.tag,
    'ok',
  )
}

/** Overall state of `cells`, as `RepoHealthStatus` defines it. */
export function healthOf(cells: RepoHealthCells): RepoHealthStatus {
  const tones = Object.values(cells).map((entry) => entry.tone)
  if (tones.includes('bad')) return 'failing'
  if (tones.includes('warn')) return 'warnings'
  if (tones.every((tone) => tone === 'none')) return 'not-analysed'
  return 'healthy'
}

/** Setting key of the `bundle` analyzer's options, where bundle budgets live. */
export const BUNDLE_SETTING = 'analyzers.bundle'

const budgetsOf = (entry: SettingEntry | undefined) =>
  bundleBudgetsSchema.safeParse(field(entry?.secret ? undefined : entry?.value, 'budgets')).data

/**
 * The bundle budgets that apply to `repo`: the `budgets` field of the winning `analyzers.bundle`
 * entry of `settings`; `undefined` when no entry sets valid budgets.
 */
export const bundleBudgetsFor = (settings: readonly SettingEntry[], repo: RepoTarget) =>
  budgetsOf(settingCascades(settings, repo).get(BUNDLE_SETTING)?.[0])

/** The analyzer options a repository's cells are judged by, from its settings cascade. */
function judgedBy(settings: readonly SettingEntry[], repo: RepoTarget) {
  const cascades = settingCascades(settings, repo)
  const coverage = cascades.get('analyzers.coverage')?.[0]
  const budgets = budgetsOf(cascades.get(BUNDLE_SETTING)?.[0])
  return {
    target: coverageTargetOf(coverage?.secret ? undefined : coverage?.value),
    ...(budgets && { budgets }),
  }
}

/** Indexes sources by repository, so classifying many repositories reads each list once. */
export function indexSources(sources: HealthSources) {
  const heads = new Map<string, Map<string, AnalysisHead>>()
  for (const head of sources.heads) {
    const kinds = heads.get(repoKey(head.repo)) ?? new Map<string, AnalysisHead>()
    if (!kinds.has(head.kind)) kinds.set(head.kind, head)
    heads.set(repoKey(head.repo), kinds)
  }
  const jobs = new Map<string, Job[]>()
  for (const job of sources.jobs)
    if (job.group === undefined)
      jobs.set(repoKey(job.repo), [...(jobs.get(repoKey(job.repo)) ?? []), job])
  const releases = new Map(sources.releases.map((card) => [repoKey(card.repo), card]))
  const audits = new Map<string, AuditRunSummary>()
  for (const run of sources.audits ?? [])
    if (!audits.has(repoKey(run.repo))) audits.set(repoKey(run.repo), run)
  return { sources, heads, jobs, releases, audits }
}

/** Sources indexed by `indexSources`. */
type IndexedSources = ReturnType<typeof indexSources>

/**
 * Health of `repo`: the cells `access` allows (others are left out), the overall state over those
 * cells, and freshness and the last analysis time when `access` allows `analyses:read`. Thresholds
 * are this module's; the coverage target and bundle budgets come from the repository's
 * `analyzers.coverage` and `analyzers.bundle` settings.
 */
export function repoHealth(
  indexed: IndexedSources,
  repo: RepoTarget,
  access: HealthAccess,
): RepoHealth {
  const { sources } = indexed
  const key = repoKey(repo)
  const heads = indexed.heads.get(key) ?? new Map<string, AnalysisHead>()
  let judged: ReturnType<typeof judgedBy> | undefined
  const options = () => (judged ??= judgedBy(sources.settings, repo))
  const build: Record<RepoHealthCellKey, () => RepoHealthCell> = {
    security: () => securityCell(heads.get('audit'), indexed.audits.get(key)),
    dependencies: () => dependenciesCell(heads.get('renovate')),
    coverage: () => coverageCell(heads.get('coverage'), options().target),
    bundles: () => bundlesCell(heads.get('bundle'), options().budgets),
    jobs: () => jobsCell(indexed.jobs.get(key) ?? [], sources.now),
    ci: () => ciCell(heads.get('ci-jobs')),
    licenses: () => licensesCell(heads.get('licenses')),
    release: () => releaseCell(indexed.releases.get(key), sources.now),
  }
  const allowed = new Map<Action, boolean>()
  const may = (action: Action) => {
    if (!allowed.has(action)) allowed.set(action, access(action))
    return allowed.get(action) === true
  }
  const cells: RepoHealthCells = {}
  for (const name of cellOrder) if (may(cellActions[name])) cells[name] = build[name]()
  const health = healthOf(cells)
  if (!may('analyses:read')) return { health, cells }
  const list = [...heads.values()]
  const lastAnalysedAt = list
    .map((head) => head.createdAt)
    .toSorted()
    .at(-1)
  return {
    health,
    cells,
    freshness: {
      current: list.filter((head) => !isStale(head, sources.now)).length,
      total: list.length,
    },
    ...(lastAnalysedAt && { lastAnalysedAt }),
  }
}

/** Jobs read for the jobs cell. */
const JOBS_READ = 500

/** Audit runs read for the security cell. */
const AUDITS_READ = 500

/**
 * Reads `HealthSources` once per request: every setting entry, the newest main-line heads (of
 * `repo` when given) with read-time metrics, the newest jobs of `jobRepos` (none when it is an
 * empty list, all when absent), the cards `releases` gives (none without it) and, with `audits`,
 * the newest audit runs (of `repo` when given). Heads of kinds `known` rejects are left out.
 */
export async function readHealthSources(
  deps: Pick<ServerDeps, 'store' | 'analyses' | 'now'>,
  options: {
    /** Only heads of this repository. */
    repo?: RepoRef
    jobRepos?: RepoRef[]
    releases?: () => Promise<ReleaseCard[]>
    audits?: boolean
    known?: (kind: string) => boolean
  } = {},
): Promise<HealthSources> {
  const { store } = deps
  const kinds = new Map(deps.analyses.map((kind) => [kind.kind, kind]))
  const [settings, heads, jobs, releases, runs] = await Promise.all([
    store.settings.list(),
    latestHeadsWithMetrics(store.analyses, kinds, options.repo ? { repo: options.repo } : {}),
    options.jobRepos?.length === 0
      ? []
      : store.jobs.list({ ...(options.jobRepos && { repos: options.jobRepos }), limit: JOBS_READ }),
    options.releases ? options.releases() : [],
    options.audits
      ? store.auditRuns.list({ ...(options.repo && { repo: options.repo }), limit: AUDITS_READ })
      : [],
  ])
  const known = options.known ?? (() => true)
  return {
    now: deps.now(),
    settings,
    heads: heads.filter((head) => known(head.kind)),
    jobs,
    releases,
    audits: runs.map(summarizeRun),
  }
}
