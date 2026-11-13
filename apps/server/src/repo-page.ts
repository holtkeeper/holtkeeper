import type { Action, RepoTarget } from '@holtkeeper/access'
import { metricsOf } from '@holtkeeper/analyzer'
import { auditAnalysis } from '@holtkeeper/analyzers'
import type {
  AnalysisSummary,
  AuditRunSummary,
  HealthTone,
  ReleaseCard,
  RepoAccessSummary,
  RepoCardKey,
  RepoCardSegment,
  RepoHealthCell,
  RepoHealthCells,
  RepoKnowledgeSummary,
  RepoOverview,
  RepoOverviewCard,
  RepoReleaseSummary,
  RepoReviewTotals,
  RepoStackView,
  RepoToolchainEntry,
  RepoWorkSummary,
  StackConventionStatus,
  StackSupport,
} from '@holtkeeper/api'
import { assetsAnalysis } from '@holtkeeper/assets'
import { budgetFor, budgetVerdict, bundleAnalysis, bundleBudgetsSchema } from '@holtkeeper/bundles'
import { ciJobsAnalysis } from '@holtkeeper/ci-jobs'
import { coverageAnalysis, coverageTargetOf } from '@holtkeeper/coverage'
import type { RepoRef } from '@holtkeeper/forge'
import { familyOf, guideScopeKey } from '@holtkeeper/guide'
import { licensesAnalysis } from '@holtkeeper/licenses'
import { renovateAnalysis } from '@holtkeeper/renovate'
import { formatBytes } from '@holtkeeper/report'
import { type ReviewData, reviewDataSchema } from '@holtkeeper/review'
import {
  repoAnalyzersKey,
  repoFreeze,
  repoTests,
  resolveRepoAnalyzers,
  resolveRepoFreeze,
  resolveRepoTests,
  settingCascades,
} from '@holtkeeper/settings'
import type {
  AnalysisHead,
  AnalysisRecord,
  ReactionSignal,
  SettingEntry,
  Store,
} from '@holtkeeper/store'

import { summarizeAnalysis } from './analyses.ts'
import { type ServerDeps, repoKey } from './context.ts'
import { readHead } from './freshness.ts'
import { OFF_FALLBACK } from './repo-analyzers.ts'
import {
  FIRST_RUN,
  type HealthAccess,
  indexSources,
  readHealthSources,
  repoHealth,
} from './repo-health.ts'
import { repoDependencies, stackGroupViews } from './stack.ts'
import { tasksWriteSettings } from './write-tasks.ts'

const REVIEWS_30D_READ = 200
const USAGE_READ = 2000
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const COVERAGE_DROP_WARN = 1

const supportRank: Record<StackSupport, number> = {
  eol: 0,
  'eol-soon': 1,
  unknown: 2,
  lts: 3,
  active: 4,
}

const sameRepo = (a: RepoRef, b: RepoRef) => a.forge === b.forge && a.path === b.path

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

const ago = (from: string, now: Date) => {
  const hours = Math.max(0, now.getTime() - Date.parse(from)) / HOUR_MS
  if (hours < 1) return 'just now'
  if (hours < 24) return `${Math.floor(hours)} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

const durationText = (seconds: number) => {
  const rounded = Math.round(seconds)
  const minutes = Math.floor(rounded / 60)
  return minutes ? `${minutes}m ${rounded % 60}s` : `${rounded}s`
}

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined

const segmentsOf = (parts: [HealthTone, number][]): RepoCardSegment[] | undefined => {
  const total = parts.reduce((sum, [, value]) => sum + value, 0)
  if (!total) return undefined
  return parts
    .filter(([, value]) => value > 0)
    .map(([tone, value]) => ({ tone, share: Math.round((value / total) * 1000) / 1000 }))
}

interface Toolchain {
  stack?: RepoStackView
  toolchain: RepoToolchainEntry[]
}

/** The repository's stack and toolchain from the newest `stack` records of the groups that list it. */
async function repoStack(
  analyses: Store['analyses'],
  repo: RepoRef,
  groupsOf: (repo: RepoRef) => string[],
): Promise<Toolchain> {
  const views = (
    await stackGroupViews(analyses, { canRead: (other) => sameRepo(other, repo), groupsOf })
  ).filter((view) => view.forge === repo.forge && view.repos.some((r) => r.path === repo.path))
  if (!views.length) return { toolchain: [] }
  const tools = new Map<string, RepoStackView['tools'][number]>()
  const toolchain = new Map<string, RepoToolchainEntry>()
  const conventions: Record<StackConventionStatus, number> = {
    matches: 0,
    drifts: 0,
    missing: 0,
    error: 0,
  }
  const files = new Set<string>()
  for (const view of views) {
    for (const tool of view.tools)
      for (const use of tool.uses) {
        if (use.repo !== repo.path) continue
        if ((tool.kind === 'runtime' || tool.kind === 'package-manager') && !toolchain.has(tool.id))
          toolchain.set(tool.id, { name: tool.id, version: use.version ?? use.declared })
        const key = `${tool.id}\0${use.file}\0${use.declared}`
        if (tools.has(key)) continue
        tools.set(key, {
          id: tool.id,
          name: tool.name,
          declared: use.declared,
          file: use.file,
          support: use.support,
          ...(use.eolDate ? { eolDate: use.eolDate } : {}),
        })
      }
    for (const result of view.conventions) {
      if (result.repo !== repo.path || files.has(result.file)) continue
      files.add(result.file)
      conventions[result.status]++
    }
  }
  return {
    stack: {
      checkedAt: views.reduce(
        (newest, view) => (view.checkedAt > newest ? view.checkedAt : newest),
        views[0]?.checkedAt ?? '',
      ),
      tools: [...tools.values()].toSorted(
        (a, b) => supportRank[a.support] - supportRank[b.support] || a.name.localeCompare(b.name),
      ),
      conventions,
    },
    toolchain: [...toolchain.values()],
  }
}

interface ReviewTally {
  posted: number
  resolved: number
  costUsd?: number
  reactions: { up: number; down: number }
}

function reviewTally(data: ReviewData, signals: readonly ReactionSignal[]): ReviewTally {
  const iid = data.mergeRequest.id
  const findings = new Set(data.comments.filter((c) => c.posted).map((c) => c.id))
  const reactions = { up: 0, down: 0 }
  for (const signal of signals)
    if (
      signal.mergeRequest === iid &&
      signal.findingId !== undefined &&
      findings.has(signal.findingId)
    ) {
      reactions.up += signal.up
      reactions.down += signal.down
    }
  return {
    posted: findings.size,
    resolved: data.threads.filter((thread) => thread.action === 'resolved').length,
    ...(data.usage?.costUsd !== undefined ? { costUsd: data.usage.costUsd } : {}),
    reactions,
  }
}

async function reviewTallies(
  store: Store,
  repo: RepoRef,
  records: readonly AnalysisRecord[],
): Promise<ReviewTally[]> {
  const parsed = records.flatMap((record) => {
    const data = reviewDataSchema.safeParse(record.data).data
    return data ? [{ record, data }] : []
  })
  const signals = parsed.length
    ? await store.learnings.reactions({
        repo: repoKey(repo),
        mergeRequests: [...new Set(parsed.map(({ data }) => data.mergeRequest.id))],
      })
    : []
  return parsed.map(({ data }) => reviewTally(data, signals))
}

async function reviewTotals(store: Store, repo: RepoRef, now: Date): Promise<RepoReviewTotals> {
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString()
  const records = await store.analyses.list({
    repo,
    kind: 'review',
    since,
    limit: REVIEWS_30D_READ,
  })
  const totals: RepoReviewTotals = {
    reviews: 0,
    posted: 0,
    resolved: 0,
    up: 0,
    down: 0,
    costUsd: 0,
  }
  for (const review of await reviewTallies(store, repo, records)) {
    totals.reviews++
    totals.posted += review.posted
    totals.resolved += review.resolved
    totals.up += review.reactions.up
    totals.down += review.reactions.down
    totals.costUsd += review.costUsd ?? 0
  }
  return totals
}

/** Monday 00:00 UTC of the week `now` is in. */
const mondayOf = (now: Date) =>
  new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - ((now.getUTCDay() + 6) % 7),
    ),
  ).toISOString()

async function workSummary(
  store: Store,
  repo: RepoRef,
  now: Date,
  reach: { tasks: boolean; spend: boolean },
): Promise<RepoWorkSummary> {
  const since = mondayOf(now)
  const [counts, proposed, usage] = await Promise.all([
    store.jobs.count({ repos: [repo], since }),
    reach.tasks ? store.tasks.list({ repos: [repoKey(repo)], status: ['proposed'] }) : undefined,
    reach.spend ? store.aiUsage.list({ repo, from: since, limit: USAGE_READ }) : undefined,
  ])
  return {
    runs: counts.total,
    failed: counts.byStatus.failed,
    ...(proposed && { awaitingApproval: proposed.length }),
    ...(usage && {
      costUsd: usage
        .filter((record) => record.jobId !== undefined)
        .reduce((sum, record) => sum + record.costUsd, 0),
    }),
  }
}

const hasContent = (section: {
  rules: string
  generated?: unknown
  proposal?: unknown
  learnings: unknown[]
}) =>
  section.rules.trim() !== '' ||
  section.generated !== undefined ||
  section.proposal !== undefined ||
  section.learnings.length > 0

async function knowledgeSummary(
  store: Store,
  repo: RepoTarget,
  titleOf: (group: string) => string,
): Promise<RepoKnowledgeSummary> {
  const key = repoKey(repo)
  const family = familyOf(await store.families.list(), key)
  const groupScopes = repo.groups.map((group) => ({
    label: `group ${titleOf(group)}`,
    scope: guideScopeKey({ kind: 'group', group }),
  }))
  const familyScope = family
    ? [
        {
          label: `family ${family.name}`,
          scope: guideScopeKey({ kind: 'family', family: family.id }),
        },
      ]
    : []
  const own = guideScopeKey({ kind: 'repo', forge: repo.forge, path: repo.path })
  const [sections, notes, proposed] = await Promise.all([
    store.guides.list({ scopes: [own, ...[...groupScopes, ...familyScope].map((s) => s.scope)] }),
    store.knowledge.list({ status: ['accepted', 'proposed'] }),
    store.learnings.list({ repos: [key], status: ['proposed'] }),
  ])
  const filled = new Set(sections.filter(hasContent).map((section) => section.scope))
  return {
    sections: sections.filter((section) => section.scope === own && hasContent(section)).length,
    notes: notes.filter((entry) => entry.scope.repos?.includes(key) === true).length,
    proposed: proposed.length,
    inherits: [...groupScopes, ...familyScope]
      .filter(({ scope }) => filled.has(scope))
      .map(({ label }) => label),
  }
}

function releaseSummary(card: ReleaseCard): RepoReleaseSummary {
  const deploy =
    card.deploy && card.latest && card.deploy.tag === card.latest.tag ? card.deploy : undefined
  const deployed = (deploy?.environments ?? [])
    .flatMap((env) => {
      if (env.status !== 'success') return []
      const at = env.attempts.find((attempt) => attempt.finishedAt)?.finishedAt ?? env.current?.at
      return at ? [{ environment: env.name, at }] : []
    })
    .toSorted((a, b) => b.at.localeCompare(a.at))[0]
  return {
    stage: card.stage,
    ...(card.latest ? { latest: card.latest } : {}),
    ...(card.next ? { next: card.next } : {}),
    ...(card.bump ? { bump: card.bump } : {}),
    unreleased: card.unreleased,
    unreleasedCapped: card.unreleasedCapped,
    ...(deployed ? { deployed } : {}),
  }
}

async function accessSummary(
  store: Store,
  repo: RepoTarget,
  now: Date,
): Promise<RepoAccessSummary> {
  const [entries, write] = await Promise.all([
    store.settings.list(repoFreeze.key),
    tasksWriteSettings(store),
  ])
  const freeze = resolveRepoFreeze(entries, repo, now)
  const decides = freeze.frozen || freeze.lifted
  return {
    readOnly: freeze.frozen,
    ...(freeze.lifted && { lifted: true }),
    ...(decides && freeze.reason !== undefined && { reason: freeze.reason }),
    ...(decides && freeze.until !== undefined && { until: new Date(freeze.until).toISOString() }),
    writeTasks: !freeze.frozen && write.enabled,
  }
}

/** The analyzer options the Quality cards are judged by, as the health cells judge them. */
function judgedBy(settings: readonly SettingEntry[], repo: RepoTarget) {
  const cascades = settingCascades(settings, repo)
  const coverage = cascades.get('analyzers.coverage')?.[0]
  const bundle = cascades.get('analyzers.bundle')?.[0]
  const budgets = bundleBudgetsSchema.safeParse(
    field(bundle?.secret ? undefined : bundle?.value, 'budgets'),
  )
  return {
    target: coverageTargetOf(coverage?.secret ? undefined : coverage?.value),
    budgets: budgets.success ? budgets.data : undefined,
    tests: resolveRepoTests(cascades.get(repoTests.key) ?? [], repo),
    analyzers: resolveRepoAnalyzers(cascades.get(repoAnalyzersKey) ?? [], repo),
  }
}

const metricValue = (summary: AnalysisSummary | undefined, id: string) => {
  const value = summary?.metrics.find((metric) => metric.id === id)?.value
  return typeof value === 'number' ? value : undefined
}

interface CardInputs {
  now: Date
  heads: ReadonlyMap<string, AnalysisHead>
  summaries: ReadonlyMap<string, AnalysisSummary>
  cells: RepoHealthCells
  audit?: AuditRunSummary
  direct?: number
  stack?: RepoStackView
  toolchain: RepoToolchainEntry[]
  judged: ReturnType<typeof judgedBy>
  may: (action: Action) => boolean
  /** Whether the last freshness sweep found the analyzer `kind` does not apply to the repository. */
  notApplicable: (kind: string) => boolean
}

const notAnalysed = (
  key: RepoCardKey,
  section: RepoOverviewCard['section'],
  unit: string,
  lines: string[] = [],
): RepoOverviewCard => ({
  key,
  section,
  tone: 'none',
  status: 'Not analysed',
  value: '—',
  unit,
  lines,
})

const card = (
  key: RepoCardKey,
  section: RepoOverviewCard['section'],
  fields: Omit<RepoOverviewCard, 'key' | 'section' | 'lines' | 'segments'> & {
    lines: (string | false | undefined)[]
    segments?: RepoCardSegment[] | undefined
    analysisId?: string | undefined
  },
): RepoOverviewCard => {
  const { lines, segments, analysisId, ...rest } = fields
  return {
    key,
    section,
    ...rest,
    lines: lines
      .filter((line): line is string => typeof line === 'string' && line !== '')
      .slice(0, 2),
    ...(segments?.length ? { segments } : {}),
    ...(analysisId ? { analysisId } : {}),
  }
}

const fromCell = (cell: RepoHealthCell | undefined) =>
  cell && cell.tone !== 'none' ? { tone: cell.tone, status: cell.value } : undefined

function securityCard({ heads, audit, cells, now }: CardInputs): RepoOverviewCard {
  const head = heads.get('audit')
  const fromRun = audit && (!head || audit.finishedAt > head.createdAt)
  const metrics = head ? metricsOf(auditAnalysis, head) : undefined
  const counts = fromRun
    ? { severities: audit.severities, ignored: audit.ignored, expired: audit.expiredAllowlist }
    : metrics
  if (!counts) return notAnalysed('security', 'supply', 'active findings')
  const { critical, high, medium, low, unknown } = counts.severities
  const active = critical + high + medium + low + unknown
  const at = fromRun ? audit.finishedAt : (head?.createdAt ?? '')
  const status = fromCell(cells.security) ?? { tone: 'ok' as const, status: 'None' }
  return card('security', 'supply', {
    ...status,
    value: String(active),
    unit: active === 1 ? 'active finding' : 'active findings',
    segments: segmentsOf([
      ['bad', critical + high],
      ['warn', medium],
      ['info', low + unknown],
    ]),
    lines: [
      `${critical + high} high or critical · ${medium} medium · ${low + unknown} low`,
      [
        `Audited ${ago(at, now)}`,
        counts.ignored ? `${counts.ignored} allowlisted` : '',
        counts.expired ? `${counts.expired} expired` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    analysisId: head?.id,
  })
}

function librariesCard({
  heads,
  summaries,
  cells,
  direct,
  now,
  judged,
}: CardInputs): RepoOverviewCard {
  const graph = summaries.get('depgraph')
  const updatesOff = judged.analyzers.off.includes('renovate')
  const renovate = updatesOff ? undefined : heads.get('renovate')
  const metrics = renovate ? metricsOf(renovateAnalysis, renovate) : undefined
  const pending = cells.dependencies?.sub === FIRST_RUN ? cells.dependencies : undefined
  if (!graph && !metrics)
    return notAnalysed(
      'libraries',
      'supply',
      'direct dependencies',
      pending ? [`Update check: first run ${pending.value.toLowerCase()}`] : [],
    )
  const total = metricValue(graph, 'packages')
  const major = metrics?.major ?? 0
  const behind = metrics ? metrics.outdated - major : 0
  const current = metrics ? Math.max(0, metrics.dependencies - metrics.outdated) : 0
  return card('libraries', 'supply', {
    ...(fromCell(cells.dependencies) ?? {
      tone: 'none',
      status: updatesOff
        ? 'Updates off'
        : pending
          ? `Update check ${pending.value.toLowerCase()}`
          : 'Not checked for updates',
    }),
    value: direct === undefined ? '—' : String(direct),
    unit: total === undefined ? 'direct' : `direct · ${total.toLocaleString('en-US')} total`,
    segments: metrics
      ? segmentsOf([
          ['ok', current],
          ['warn', behind],
          ['bad', major],
        ])
      : undefined,
    lines: [
      metrics && `${current} current · ${behind} minor or patch · ${major} major behind`,
      graph && `Graph read ${ago(graph.createdAt, now)}`,
    ],
    analysisId: graph?.id ?? renovate?.id,
  })
}

function licensesCard({ heads, cells, now }: CardInputs): RepoOverviewCard {
  const head = heads.get('licenses')
  const metrics = head ? metricsOf(licensesAnalysis, head) : undefined
  if (!head || !metrics) return notAnalysed('licenses', 'supply', 'violations')
  const { allowed, internal, ignored, unknown, unlisted, denied } = metrics.verdicts
  return card('licenses', 'supply', {
    ...(fromCell(cells.licenses) ?? { tone: 'ok', status: 'Within policy' }),
    value: String(metrics.violations),
    unit: metrics.violations === 1 ? 'violation' : 'violations',
    segments: segmentsOf([
      ['ok', allowed + internal + ignored],
      ['warn', unknown + unlisted],
      ['bad', denied],
    ]),
    lines: [
      `${unknown + unlisted} to review · ${plural(metrics.packages, 'package')}`,
      `Checked ${ago(head.createdAt, now)}`,
    ],
    analysisId: head.id,
  })
}

function stackCard({ stack, toolchain }: CardInputs): RepoOverviewCard {
  if (!stack) return notAnalysed('stack', 'supply', 'not in a stack record')
  const ended = stack.tools.filter((tool) => tool.support === 'eol')
  const ending = stack.tools.filter((tool) => tool.support === 'eol-soon')
  const drift = stack.conventions.drifts + stack.conventions.missing
  const status = ended.length
    ? { tone: 'bad' as const, status: `${ended.length} ended` }
    : ending.length
      ? { tone: 'warn' as const, status: `${ending.length} ending` }
      : drift
        ? { tone: 'warn' as const, status: plural(drift, 'drift') }
        : { tone: 'ok' as const, status: 'Supported' }
  const [first] = toolchain
  const worst = ended[0] ?? ending[0]
  return card('stack', 'supply', {
    ...status,
    value: first ? `${first.name} ${first.version}` : String(stack.tools.length),
    unit: first ? 'runtime' : 'tools',
    lines: [
      worst
        ? `${worst.name} ${worst.declared} ${worst.support === 'eol' ? 'ended' : 'ends'}${worst.eolDate ? ` ${worst.eolDate}` : ''}`
        : `${plural(stack.tools.length, 'tool')} in use`,
      `Conventions: ${stack.conventions.matches} match, ${drift} drift`,
    ],
  })
}

function publicApiCard({ summaries, now }: CardInputs): RepoOverviewCard {
  const surface = summaries.get('api-surface')
  if (!surface)
    return notAnalysed('public-api', 'supply', 'no exports recorded', [
      'Runs for published packages only',
    ])
  const exports = metricValue(surface, 'exports') ?? 0
  const packages = metricValue(surface, 'packages') ?? 0
  const documented = metricValue(surface, 'documented')
  const goImportable = metricValue(surface, 'goImportable')
  const goInternal = metricValue(surface, 'goInternal') ?? 0
  const goMain = metricValue(surface, 'goMain') ?? 0
  const indexed = `Indexed ${ago(surface.createdAt, now)}`
  if (goImportable === 0 && packages <= goInternal)
    return card('public-api', 'supply', {
      tone: 'none',
      status: 'Internal only',
      value: '0',
      unit: 'importable packages',
      lines: [
        `Go service: ${plural(goMain, 'main package')}, ${plural(goInternal, 'internal package')}`,
        indexed,
      ],
      analysisId: surface.id,
    })
  if (packages === 0)
    return card('public-api', 'supply', {
      tone: 'none',
      status: 'No packages',
      value: '—',
      unit: 'exports',
      lines: ['No package with a resolvable entry point', indexed],
      analysisId: surface.id,
    })
  return card('public-api', 'supply', {
    tone: 'ok',
    status: 'Indexed',
    value: exports.toLocaleString('en-US'),
    unit: `exports in ${plural(packages, 'package')}`,
    lines: [documented !== undefined && `${Math.round(documented)}% documented`, indexed],
    analysisId: surface.id,
  })
}

const percentText = (value: number) => `${value.toFixed(1)}%`

function coverageCard({ heads, judged }: CardInputs): RepoOverviewCard {
  const head = heads.get('coverage')
  const metrics = head ? metricsOf(coverageAnalysis, head) : undefined
  if (!judged.tests.expected)
    return card('coverage', 'quality', {
      tone: 'none',
      status: 'No tests by design',
      value: '—',
      unit: 'lines',
      lines: [judged.tests.reason],
    })
  if (!head || !metrics) return notAnalysed('coverage', 'quality', 'lines')
  if (metrics.percent === undefined)
    return card('coverage', 'quality', {
      tone: 'none',
      status: 'Nothing to cover',
      value: '—',
      unit: 'lines',
      lines: [],
      analysisId: head.id,
    })
  const { target } = judged
  const dropping = metrics.delta !== undefined && metrics.delta <= -COVERAGE_DROP_WARN
  const status =
    metrics.percent < target
      ? { tone: 'bad' as const, status: 'Below target' }
      : dropping
        ? { tone: 'warn' as const, status: 'Dropping' }
        : { tone: 'ok' as const, status: 'On target' }
  return card('coverage', 'quality', {
    ...status,
    value: percentText(metrics.percent),
    unit: 'lines',
    segments: [{ tone: status.tone, share: Math.min(1, metrics.percent / 100) }],
    lines: [
      [
        metrics.branches === undefined ? '' : `Branches ${percentText(metrics.branches)}`,
        `target ${target}%`,
      ]
        .filter(Boolean)
        .join(' · '),
      metrics.delta !== undefined
        ? `${metrics.delta >= 0 ? '+' : '−'}${Math.abs(metrics.delta).toFixed(1)} pt since the last record`
        : metrics.untested
          ? `${plural(metrics.untested, 'file')} without tests`
          : '',
    ],
    analysisId: head.id,
  })
}

function bundlesCard({ heads, judged, notApplicable }: CardInputs): RepoOverviewCard {
  const head = heads.get('bundle')
  const metrics = head ? metricsOf(bundleAnalysis, head) : undefined
  if (!head && notApplicable('bundle'))
    return {
      key: 'bundles',
      section: 'quality',
      tone: 'none',
      status: 'Not applicable',
      value: '—',
      unit: 'gzip',
      lines: ['No app build or published package to measure'],
    }
  if (!head || !metrics) return notAnalysed('bundles', 'quality', 'gzip')
  const targets = metrics.targets.filter((target) => target.gzip !== undefined)
  const total = targets.reduce((sum, target) => sum + (target.gzip ?? 0), 0)
  const verdicts = targets.map((target) => {
    if (!judged.budgets) return target.verdict ?? 'ok'
    const budget = budgetFor(judged.budgets, target.name)
    return budget === undefined ? 'ok' : budgetVerdict(target.gzip ?? 0, budget)
  })
  const over = verdicts.filter((verdict) => verdict === 'over').length
  const near = verdicts.filter((verdict) => verdict === 'near').length
  const deltas = targets.flatMap((target) => (target.delta === undefined ? [] : [target.delta]))
  const delta = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) : undefined
  const status = !targets.length
    ? {
        tone: metrics.failed ? ('bad' as const) : ('none' as const),
        status: metrics.failed ? 'Failed' : 'No targets',
      }
    : over
      ? { tone: 'bad' as const, status: 'Over budget' }
      : metrics.failed
        ? { tone: 'warn' as const, status: `${metrics.failed} failed` }
        : near
          ? { tone: 'warn' as const, status: 'Near budget' }
          : { tone: 'ok' as const, status: 'Within budget' }
  return card('bundles', 'quality', {
    ...status,
    value: targets.length ? formatBytes(total) : '—',
    unit: `gzip, ${plural(targets.length, 'target')}`,
    lines: [
      delta !== undefined &&
        `${delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(delta))} since the last record`,
      over
        ? `${plural(over, 'target')} over budget`
        : near
          ? `${plural(near, 'target')} near budget`
          : '',
    ],
    analysisId: head.id,
  })
}

function assetsCard({ heads, now }: CardInputs): RepoOverviewCard {
  const head = heads.get('assets')
  const metrics = head ? metricsOf(assetsAnalysis, head) : undefined
  if (!head || !metrics) return notAnalysed('assets', 'quality', 'files')
  const status = metrics.errors
    ? { tone: 'bad' as const, status: plural(metrics.errors, 'error') }
    : metrics.warnings
      ? { tone: 'warn' as const, status: plural(metrics.warnings, 'warning') }
      : { tone: 'ok' as const, status: 'Within policy' }
  return card('assets', 'quality', {
    ...status,
    value: formatBytes(metrics.bytes),
    unit: `in ${plural(metrics.files, 'file')}`,
    lines: [
      metrics.savings ? `Could save ${formatBytes(metrics.savings)}` : 'Nothing to shrink',
      `Checked ${ago(head.createdAt, now)}`,
    ],
    analysisId: head.id,
  })
}

function ciCard({ heads, cells }: CardInputs): RepoOverviewCard {
  const head = heads.get('ci-jobs')
  const metrics = head ? metricsOf(ciJobsAnalysis, head) : undefined
  if (!head || !metrics) return notAnalysed('ci', 'quality', 'pass rate')
  const rate = metrics.successRate
  return card('ci', 'quality', {
    ...(fromCell(cells.ci) ?? { tone: 'none', status: 'Idle' }),
    value: rate === undefined ? '—' : `${Math.round(rate)}%`,
    unit: metrics.ref ? `pass rate on ${metrics.ref}` : 'pass rate',
    segments:
      rate === undefined
        ? undefined
        : segmentsOf([
            ['ok', rate],
            ['bad', 100 - rate],
          ]),
    lines: [
      metrics.failing || metrics.flaky
        ? `${metrics.failing} failing · ${metrics.flaky} flaky jobs`
        : plural(metrics.pipelines, 'pipeline'),
      metrics.median !== undefined && `Median pipeline ${durationText(metrics.median)}`,
    ],
    analysisId: head.id,
  })
}

function branchesCard({ summaries }: CardInputs): RepoOverviewCard {
  const summary = summaries.get('branches')
  const total = metricValue(summary, 'branches')
  if (!summary || total === undefined) return notAnalysed('branches', 'quality', 'branches')
  const cleanup = metricValue(summary, 'cleanup') ?? 0
  const merged = metricValue(summary, 'merged') ?? 0
  const stale = metricValue(summary, 'stale') ?? 0
  return card('branches', 'quality', {
    ...(cleanup
      ? { tone: 'info' as const, status: `${cleanup} to clean up` }
      : { tone: 'ok' as const, status: 'Tidy' }),
    value: String(total),
    unit: total === 1 ? 'branch' : 'branches',
    lines: [`${stale} stale · ${merged} merged, not deleted`],
    analysisId: summary.id,
  })
}

/** The analyzers each card describes; it is off once `repo.analyzers` turns all of them off. */
const cardAnalyzers: Record<RepoCardKey, readonly string[]> = {
  security: ['audit'],
  libraries: ['depgraph', 'renovate'],
  licenses: ['licenses'],
  stack: ['stack'],
  'public-api': ['api-surface'],
  coverage: ['coverage'],
  bundles: ['bundle'],
  assets: ['assets'],
  ci: ['ci-jobs'],
  branches: ['branches'],
}

const offCard = (from: RepoOverviewCard, reason: string | undefined): RepoOverviewCard => ({
  key: from.key,
  section: from.section,
  tone: 'none',
  status: 'Off',
  value: '—',
  unit: from.unit,
  lines: [reason ?? OFF_FALLBACK],
})

/**
 * Supply chain cards, then Quality cards; Security only with `audits:read`. A card whose analyzers
 * `repo.analyzers` turns off reads `Off` with the reason.
 */
function overviewCards(inputs: CardInputs): RepoOverviewCard[] {
  const { off, reason } = inputs.judged.analyzers
  const isOff = (key: RepoCardKey) => cardAnalyzers[key].every((kind) => off.includes(kind))
  return [
    ...(inputs.may('audits:read') ? [securityCard(inputs)] : []),
    librariesCard(inputs),
    licensesCard(inputs),
    stackCard(inputs),
    publicApiCard(inputs),
    coverageCard(inputs),
    bundlesCard(inputs),
    assetsCard(inputs),
    ciCard(inputs),
    branchesCard(inputs),
  ].map((each) => (isOff(each.key) ? offCard(each, reason) : each))
}

const defaultBranchOf = (records: readonly AnalysisRecord[]) => {
  for (const kind of ['branches', 'ci-jobs']) {
    const value = field(records.find((record) => record.kind === kind)?.data, 'defaultBranch')
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/**
 * What the repository hub's header and Overview show; stored records only, nothing from the forge
 * or a model. `access` says which permissions the caller holds on the repository: cells and cards
 * behind a missing one, the audit (also its record summary) without `audits:read`, `knowledge`
 * without `knowledge:read`, `release` without `releases:read`, write tasks waiting for approval
 * without `repos:read` and AI spend without `ai:read` or `ai:admin` are left out. The caller has
 * checked `analyses:read`.
 */
export async function repoOverview(
  deps: Pick<ServerDeps, 'store' | 'analyses' | 'analyzers' | 'now'>,
  repo: RepoTarget,
  options: {
    access: HealthAccess
    releases?: () => Promise<ReleaseCard[]>
    groupsOf: (repo: RepoRef) => string[]
    /** What people see for a group key; default the key. */
    groupTitle?: (group: string) => string
  },
): Promise<RepoOverview> {
  const { store } = deps
  const ref = { forge: repo.forge, path: repo.path }
  const kinds = new Map(deps.analyses.map((kind) => [kind.kind, kind]))
  const labels = new Set((deps.analyzers ?? []).map((analyzer) => analyzer.kind))
  const allowed = new Map<Action, boolean>()
  const may = (action: Action) => {
    if (!allowed.has(action)) allowed.set(action, options.access(action))
    return allowed.get(action) === true
  }
  const now = deps.now()
  const [latest, head, sources, dependencies, toolchain, reviews30d, work, knowledge, access] =
    await Promise.all([
      store.analyses.latest({ repo: ref }),
      store.kv ? readHead(store.kv, ref) : undefined,
      readHealthSources(deps, {
        repo: ref,
        jobRepos: [ref],
        ...(may('releases:read') && options.releases && { releases: options.releases }),
        audits: may('audits:read'),
        ...(labels.size && { known: (kind: string) => labels.has(kind) }),
      }),
      repoDependencies(store.analyses, ref),
      repoStack(store.analyses, ref, options.groupsOf),
      reviewTotals(store, ref, now),
      workSummary(store, ref, now, {
        tasks: may('repos:read'),
        spend: may('ai:read') || may('ai:admin'),
      }),
      may('knowledge:read')
        ? knowledgeSummary(store, repo, options.groupTitle ?? ((group) => group))
        : undefined,
      accessSummary(store, repo, now),
    ])
  const indexed = indexSources(sources)
  const { health, cells } = repoHealth(indexed, repo, may)
  const key = repoKey(repo)
  const audit = may('audits:read') ? indexed.audits.get(key) : undefined
  const summaries = latest
    .filter((record) => record.kind !== 'review' && (record.kind !== 'audit' || may('audits:read')))
    .map((record) => summarizeAnalysis(kinds, record))
  const depgraph = latest.find((record) => record.kind === 'depgraph')
  const release = may('releases:read') ? indexed.releases.get(key) : undefined
  const defaultBranch = defaultBranchOf(latest)
  return {
    repo: ref,
    groups: repo.groups,
    health,
    cells,
    cards: overviewCards({
      now,
      heads: indexed.heads.get(key) ?? new Map(),
      summaries: new Map(summaries.map((summary) => [summary.kind, summary])),
      cells,
      ...(audit ? { audit } : {}),
      ...(depgraph ? { direct: dependencies.length } : {}),
      ...(toolchain.stack ? { stack: toolchain.stack } : {}),
      toolchain: toolchain.toolchain,
      judged: judgedBy(sources.settings, repo),
      may,
      notApplicable: (kind) => sources.sweep?.get(`${key}\0${kind}`)?.applies === false,
    }),
    ...(head ? { head: { sha: head.sha, at: head.at } } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
    analyses: summaries,
    ...(audit ? { audit } : {}),
    ...(depgraph
      ? {
          dependencies: {
            direct: dependencies.length,
            analysisId: depgraph.id,
            createdAt: depgraph.createdAt,
          },
        }
      : {}),
    ...(toolchain.stack ? { stack: toolchain.stack } : {}),
    toolchain: toolchain.toolchain,
    reviews30d,
    work,
    ...(knowledge ? { knowledge } : {}),
    ...(release ? { release: releaseSummary(release) } : {}),
    access,
  }
}
