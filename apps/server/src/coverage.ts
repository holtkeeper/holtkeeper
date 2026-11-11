import type { RepoTarget } from '@holtkeeper/access'
import type { CoverageRepoCard, CoverageTrendPoint, RepoCoverageView } from '@holtkeeper/api'
import {
  type CoverageData,
  changedFilesCoverage,
  coverageChanges,
  coverageDataSchema,
  coverageGroups,
  coverageTotals,
  percentOf,
  worstFiles,
} from '@holtkeeper/coverage'
import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisRecord, Store } from '@holtkeeper/store'

import { LINE_SCAN, mainLineRecords } from './analyses.ts'
import { readHead } from './freshness.ts'

/** Coverage records a card's trend is drawn from. */
const TREND_RECORDS = 12

const WORST_FILES = 10

const CHANGES = 20

interface Parsed {
  record: AnalysisRecord
  data: CoverageData
}

const parse = (records: readonly AnalysisRecord[]): Parsed[] =>
  records.flatMap((record) => {
    const parsed = coverageDataSchema.safeParse(record.data)
    return parsed.success ? [{ record, data: parsed.data }] : []
  })

const round = (value: number | undefined) =>
  value === undefined ? undefined : Math.round(value * 10) / 10

function cardOf(
  target: RepoTarget,
  parsed: readonly Parsed[],
  head: string | undefined,
): CoverageRepoCard | undefined {
  const [latest, previous] = parsed
  if (!latest) return undefined
  const { record, data } = latest
  const lines = percentOf(data.summary.lines)
  const before = previous ? percentOf(previous.data.summary.lines) : undefined
  const changed = previous ? changedFilesCoverage(data, previous.data) : undefined
  const trend = parsed
    .map(({ record: point, data: pointData }): CoverageTrendPoint => {
      const lineShare = round(percentOf(pointData.summary.lines))
      const branchShare = round(percentOf(pointData.summary.branches))
      return {
        at: point.createdAt,
        ...(lineShare === undefined ? {} : { lines: lineShare }),
        ...(branchShare === undefined ? {} : { branches: branchShare }),
      }
    })
    .toSorted((a, b) => a.at.localeCompare(b.at))
  const change = lines !== undefined && before !== undefined ? round(lines - before) : undefined
  return {
    repo: { forge: target.forge, path: target.path },
    groups: [...target.groups],
    analysisId: record.id,
    createdAt: record.createdAt,
    ...(record.ref ? { ref: record.ref } : {}),
    ...(record.sha ? { sha: record.sha } : {}),
    ...(head && !record.ref && record.sha && head !== record.sha ? { head } : {}),
    tools: data.tools,
    totals: coverageTotals(data),
    ...(change === undefined ? {} : { change }),
    ...(changed ? { changed } : {}),
    trend,
  }
}

async function recordsOf(store: Pick<Store, 'analyses' | 'kv'>, repo: RepoRef) {
  const [records, head] = await Promise.all([
    store.analyses.list({ repo, kind: 'coverage', limit: LINE_SCAN }),
    store.kv ? readHead(store.kv, repo) : undefined,
  ])
  return { parsed: parse(mainLineRecords(records, TREND_RECORDS)), head: head?.sha }
}

/**
 * Coverage cards of `targets`, sorted by repository; targets without a readable coverage record
 * are left out. Reads stored records only.
 */
export async function coverageCards(
  store: Pick<Store, 'analyses' | 'kv'>,
  targets: readonly RepoTarget[],
): Promise<CoverageRepoCard[]> {
  const cards = await Promise.all(
    targets.map(async (target) => {
      const { parsed, head } = await recordsOf(store, target)
      return cardOf(target, parsed, head)
    }),
  )
  return cards
    .filter((card) => card !== undefined)
    .toSorted((a, b) =>
      `${a.repo.forge}:${a.repo.path}`.localeCompare(`${b.repo.forge}:${b.repo.path}`),
    )
}

/** One repository's coverage card with its breakdown, worst files and recent moves. */
export async function repoCoverageView(
  store: Pick<Store, 'analyses' | 'kv'>,
  target: RepoTarget,
): Promise<RepoCoverageView> {
  const { parsed, head } = await recordsOf(store, target)
  const repo = { forge: target.forge, path: target.path }
  const card = cardOf(target, parsed, head)
  const [latest, previous] = parsed
  if (!card || !latest) return { repo, groups: [], worst: [], changes: [] }
  return {
    repo,
    card,
    groups: coverageGroups(latest.data.files),
    worst: worstFiles(latest.data.files, WORST_FILES),
    changes: previous ? coverageChanges(latest.data, previous.data).slice(0, CHANGES) : [],
  }
}
