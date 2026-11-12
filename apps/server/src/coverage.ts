import type { RepoTarget } from '@holtkeeper/access'
import { metricsOf } from '@holtkeeper/analyzer'
import type { CoverageRepoCard, CoverageTrendPoint, RepoCoverageView } from '@holtkeeper/api'
import {
  type ChangedFilesCoverage,
  type CoverageData,
  type CoverageMetrics,
  type CoverageTotals,
  changedFilesCoverage,
  coverageAnalysis,
  coverageChanges,
  coverageDataSchema,
  coverageGroups,
  coverageMetrics,
  worstFiles,
} from '@holtkeeper/coverage'
import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisKind } from '@holtkeeper/report'
import { resolveSetting } from '@holtkeeper/settings'
import type { AnalysisHead, SettingEntry, Store } from '@holtkeeper/store'

import { LINE_SCAN, latestHeadsWithMetrics, mainLineRecords } from './analyses.ts'
import { repoKey } from './context.ts'
import type { FleetCache } from './fleet-cache.ts'
import { withCurrentMetrics } from './fleet-metrics.ts'
import { readHead } from './freshness.ts'

const KIND = 'coverage'

const SETTING = 'analyzers.coverage'

/** Coverage records a card's trend is drawn from. */
const TREND_RECORDS = 12

const WORST_FILES = 10

const CHANGES = 20

/** Where coverage cards are read from. */
interface CoverageSource {
  store: Pick<Store, 'analyses' | 'kv'>
  // oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
  kinds: ReadonlyMap<string, AnalysisKind<any, any>>
  targetOf: (repo: RepoRef) => RepoTarget
  /** Keeps overview answers while the newest records and freshness heads stay the same. */
  cache?: FleetCache
}

const round = (value: number | undefined) =>
  value === undefined ? undefined : Math.round(value * 10) / 10

const hasTotals = (metrics: object) => 'totals' in metrics

const metricsOfHead = (head: AnalysisHead) => metricsOf(coverageAnalysis, head)

function trendOf(line: readonly AnalysisHead[], newest: CoverageMetrics): CoverageTrendPoint[] {
  return line
    .flatMap((head, index): CoverageTrendPoint[] => {
      const metrics = index === 0 ? newest : metricsOfHead(head)
      if (!metrics) return []
      const lines = round(metrics.percent)
      const branches = round(metrics.branches)
      return [
        {
          at: head.createdAt,
          ...(lines === undefined ? {} : { lines }),
          ...(branches === undefined ? {} : { branches }),
        },
      ]
    })
    .toSorted((a, b) => a.at.localeCompare(b.at))
}

function cardOf(
  target: RepoTarget,
  line: readonly AnalysisHead[],
  newest: CoverageMetrics & { totals: CoverageTotals },
  head: string | undefined,
  changed?: ChangedFilesCoverage,
): CoverageRepoCard | undefined {
  const [record] = line
  if (!record) return undefined
  const change = round(newest.delta)
  return {
    repo: { forge: target.forge, path: target.path },
    groups: [...target.groups],
    analysisId: record.id,
    createdAt: record.createdAt,
    ...(record.ref ? { ref: record.ref } : {}),
    ...(record.sha ? { sha: record.sha } : {}),
    ...(head && !record.ref && record.sha && head !== record.sha ? { head } : {}),
    tools: newest.tools ?? [],
    totals: newest.totals,
    ...(change === undefined ? {} : { change }),
    ...(changed ? { changed } : {}),
    trend: trendOf(line, newest),
  }
}

const withTotals = (
  metrics: CoverageMetrics | undefined,
): (CoverageMetrics & { totals: CoverageTotals }) | undefined =>
  metrics?.totals ? { ...metrics, totals: metrics.totals } : undefined

/** The main line of `repo`, newest first, at most `TREND_RECORDS` heads; data is not read. */
async function lineOf(store: CoverageSource['store'], repo: RepoRef, newest?: AnalysisHead) {
  const heads = await store.analyses.heads({ repo, kind: KIND, limit: LINE_SCAN })
  const line = mainLineRecords(heads, TREND_RECORDS)
  return newest && line[0]?.id === newest.id ? [newest, ...line.slice(1)] : line
}

const headOf = async (store: CoverageSource['store'], repo: RepoRef) =>
  store.kv ? (await readHead(store.kv, repo))?.sha : undefined

/**
 * Coverage cards of the repositories `canRead` allows that have a coverage record, sorted by
 * repository. Built from stored metrics: the newest main-line head of each repository and the
 * heads of its last `TREND_RECORDS` records; record data is read only for a newest record whose
 * metrics predate the counts the card shows.
 */
export async function coverageCards(
  source: CoverageSource,
  canRead: (target: RepoTarget) => boolean,
): Promise<CoverageRepoCard[]> {
  const { store } = source
  const newest = (
    await latestHeadsWithMetrics(store.analyses, source.kinds, { kind: KIND })
  ).filter((head) => canRead(source.targetOf(head.repo)))
  const heads = await Promise.all(newest.map((head) => headOf(store, head.repo)))
  const build = async () => {
    const current = await withCurrentMetrics(
      store.analyses,
      source.kinds.get(KIND) ?? coverageAnalysis,
      newest,
      hasTotals,
    )
    const cards = await Promise.all(
      current.map(async (latest, index) => {
        const metrics = withTotals(metricsOfHead(latest))
        if (!metrics) return undefined
        const target = source.targetOf(latest.repo)
        return cardOf(target, await lineOf(store, latest.repo, latest), metrics, heads[index])
      }),
    )
    return cards
      .filter((card) => card !== undefined)
      .toSorted((a, b) => repoKey(a.repo).localeCompare(repoKey(b.repo)))
  }
  if (!source.cache) return build()
  return source.cache.read(
    {
      endpoint: `coverage?heads=${newest.map((head, index) => `${repoKey(head.repo)}=${heads[index] ?? ''}`).join(',')}`,
      analysisIds: newest.map((head) => head.id),
      repos: newest.map((head) => repoKey(head.repo)),
    },
    build,
  )
}

function targetOf(entries: readonly SettingEntry[], repo: RepoTarget): number | undefined {
  const entry = resolveSetting(entries, SETTING, repo)
  const value =
    entry &&
    !entry.secret &&
    typeof entry.value === 'object' &&
    entry.value &&
    'target' in entry.value
      ? entry.value.target
      : undefined
  const target =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN
  return Number.isFinite(target) && target >= 0 && target <= 100 ? target : undefined
}

/**
 * `cards` with each repository's own coverage target: the `target` of the `analyzers.coverage`
 * entry that applies to it, left out when that entry sets none.
 */
export async function withCoverageTargets(
  store: Pick<Store, 'settings'>,
  cards: readonly CoverageRepoCard[],
  repoTargetOf: (repo: RepoRef) => RepoTarget,
): Promise<CoverageRepoCard[]> {
  const entries = await store.settings.list(SETTING)
  return cards.map((card) => {
    const target = targetOf(entries, repoTargetOf(card.repo))
    return target === undefined ? card : { ...card, target }
  })
}

const parse = (data: unknown): CoverageData | undefined => coverageDataSchema.safeParse(data).data

/**
 * One repository's coverage card with its breakdown, worst files and recent moves. Reads the heads
 * of its main line and the data of its two newest records only.
 */
export async function repoCoverageView(
  store: CoverageSource['store'],
  target: RepoTarget,
): Promise<RepoCoverageView> {
  const repo = { forge: target.forge, path: target.path }
  const [line, head] = await Promise.all([lineOf(store, repo), headOf(store, repo)])
  const [newest, before] = line
  const empty = { repo, groups: [], worst: [], changes: [] }
  if (!newest) return empty
  const [latestRecord, previousRecord] = await Promise.all([
    store.analyses.get(newest.id),
    before ? store.analyses.get(before.id) : undefined,
  ])
  const latest = parse(latestRecord?.data)
  if (!latest) return empty
  const previous = parse(previousRecord?.data)
  const stored = metricsOfHead(newest)
  const previousMetrics =
    (before && metricsOfHead(before)) ?? (previous ? coverageMetrics(previous) : undefined)
  const metrics = withTotals({
    ...coverageMetrics(latest, previousMetrics ? { previous: previousMetrics } : {}),
    ...stored,
  })
  const changed = previous ? changedFilesCoverage(latest, previous) : undefined
  const card = metrics && cardOf(target, line, metrics, head, changed)
  return {
    repo,
    ...(card ? { card } : {}),
    groups: coverageGroups(latest.files),
    worst: worstFiles(latest.files, WORST_FILES),
    changes: previous ? coverageChanges(latest, previous).slice(0, CHANGES) : [],
  }
}
