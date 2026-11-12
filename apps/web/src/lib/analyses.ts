import type { AnalysisSummary, Block, Metric, Report, Section } from '@holtkeeper/api'

import { searchEntry, searchEnum, searchText } from './search-params.ts'
import { formatValue } from './units.ts'

/** Every block type in the report model; the compiler fails when the model gains a new one. */
export const blockTypes = [
  'metrics',
  'table',
  'chart',
  'treemap',
  'timeline',
  'graph',
  'issues',
  'markdown',
  'changes',
  'heatmap',
] as const satisfies readonly Block['type'][]

type MissingBlock = Exclude<Block['type'], (typeof blockTypes)[number]>
const exhaustive: MissingBlock extends never ? true : never = true
void exhaustive

/**
 * Workspace pages for analysis kinds: route, the workspace and repository hub area they belong to,
 * kind, title and the metrics their trend prefers.
 */
export const analysisPages = [
  {
    to: '/quality/bundles',
    workspace: 'quality',
    section: 'bundles',
    kind: 'bundle',
    title: 'Bundles',
    trend: [/gzip/i, /size/i],
  },
  {
    to: '/supply/libraries',
    workspace: 'supply',
    section: 'libraries',
    kind: 'depgraph',
    title: 'Libraries',
    trend: [/cycle/i, /duplicate/i],
  },
  {
    to: '/quality/coverage',
    workspace: 'quality',
    section: 'coverage',
    kind: 'coverage',
    title: 'Coverage',
    trend: [/line coverage/i, /without tests/i],
  },
  {
    to: '/quality/branches',
    workspace: 'quality',
    section: 'branches',
    kind: 'branches',
    title: 'Branches',
    trend: [/clean up/i, /stale/i],
  },
  {
    to: '/quality/ci',
    workspace: 'quality',
    section: 'ci',
    kind: 'ci-jobs',
    title: 'CI',
    trend: [/pipeline time/i, /success rate/i],
  },
  {
    to: '/supply/licenses',
    workspace: 'supply',
    section: 'licenses',
    kind: 'licenses',
    title: 'Licenses',
    trend: [/violations/i, /unknown/i],
  },
  {
    to: '/supply/public-api',
    workspace: 'supply',
    section: 'public-api',
    kind: 'api-surface',
    title: 'Public API',
    trend: [/documented/i, /exports/i],
  },
  {
    to: '/quality/assets',
    workspace: 'quality',
    section: 'assets',
    kind: 'assets',
    title: 'Assets',
    trend: [/sav/i, /size/i],
  },
  {
    to: '/quality/reviews',
    workspace: 'quality',
    section: 'reviews',
    kind: 'review',
    title: 'Reviews',
    trend: [/finding/i],
  },
] as const

/** Where records of the group-scoped `stack` kind belong: Supply › Stack. */
export const stackRecords = { to: '/supply/stack', kind: 'stack', title: 'Stack' } as const

/**
 * The repository hub tab and area that show records of `kind`: Quality or Supply chain and the
 * kind's area there, `undefined` for kinds without one (the hub's Overview).
 */
export function recordRepoTab(
  kind: string,
): { tab: 'quality' | 'supply'; section: string } | undefined {
  const page = analysisPages.find((p) => p.kind === kind)
  return page ? { tab: page.workspace, section: page.section } : undefined
}

/**
 * Metrics worth charting across records: numeric in the newest record, one per pattern in
 * `prefer` (in that order), or the first numeric metric when none matches. Empty without data.
 */
export function trendMetrics(
  analyses: readonly AnalysisSummary[],
  prefer: readonly RegExp[] = [],
): Metric[] {
  const numeric = analyses[0]?.metrics.filter((m) => typeof m.value === 'number') ?? []
  const picked: Metric[] = []
  for (const pattern of prefer) {
    const match = numeric.find(
      (m) => !picked.includes(m) && (pattern.test(m.id) || pattern.test(m.label)),
    )
    if (match) picked.push(match)
  }
  return picked.length ? picked : numeric.slice(0, 1)
}

/** Section anchor id, safe for `id` attributes and URLs. */
export const sectionAnchor = (id: string): string =>
  `section-${id.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`

/**
 * `report` split for the record page's tabs: the report without its `changes` blocks (sections
 * left empty are dropped), the sections holding only those blocks, and the number of changes.
 */
export function splitChanges(report: Report): {
  report: Report
  changes: Section[]
  count: number
} {
  const changes = report.sections.flatMap((section) => {
    const blocks = section.blocks.filter((block) => block.type === 'changes')
    return blocks.length ? [{ ...section, blocks }] : []
  })
  const sections = report.sections.flatMap((section) => {
    const blocks = section.blocks.filter((block) => block.type !== 'changes')
    return blocks.length ? [{ ...section, blocks }] : []
  })
  const count = changes
    .flatMap((section) => section.blocks)
    .reduce((sum, block) => sum + (block.type === 'changes' ? block.items.length : 0), 0)
  return { report: { ...report, sections }, changes, count }
}

/** One record on the record page's version chart. */
export interface VersionPoint {
  id: string
  createdAt: string
  value?: number
  /** `value` with its unit, `—` without one. */
  text: string
  /** Bar height between 0 and 1 relative to the shown records; 0 without a value. */
  height: number
  /** A release tag the record ran on, e.g. `v2.13.0`. */
  tag?: string
  /** `a` is the compare base, `b` the record shown. */
  role?: 'a' | 'b'
}

const releaseTag = (ref: string | undefined): string | undefined => {
  const name = ref?.replace(/^refs\/tags\//, '')
  return name && /^v?\d+(\.\d+)+/.test(name) ? name : undefined
}

/**
 * Records of one kind and repository as chart points, oldest first: at most `max` of them, the
 * window placed so `pair.b` (the record shown) and, when it fits, `pair.a` are inside it. Values
 * come from `metric`; records without it stay on the chart with no bar.
 */
export function versionPoints(
  records: readonly AnalysisSummary[],
  metric: Pick<Metric, 'id' | 'unit'>,
  pair: { a?: string | undefined; b: string },
  max = 24,
): VersionPoint[] {
  const ordered = records.toSorted((x, y) => x.createdAt.localeCompare(y.createdAt))
  const indexOf = (id: string | undefined) => ordered.findIndex((record) => record.id === id)
  const b = indexOf(pair.b)
  const a = indexOf(pair.a)
  const anchor = b < 0 ? ordered.length - 1 : b
  const both = a >= 0 && Math.abs(a - anchor) < max
  const low = both ? Math.min(a, anchor) : anchor
  const high = both ? Math.max(a, anchor) : anchor
  let end = Math.min(ordered.length, high + 3)
  let start = Math.max(0, end - max)
  if (low < start) {
    start = low
    end = Math.min(ordered.length, start + max)
  }
  const shown = ordered.slice(start, end)
  const value = (record: AnalysisSummary) => {
    const found = record.metrics.find((m) => m.id === metric.id)?.value
    return typeof found === 'number' && Number.isFinite(found) ? found : undefined
  }
  const values = shown.flatMap((record) => {
    const v = value(record)
    return v === undefined ? [] : [v]
  })
  const least = Math.min(...values)
  const most = Math.max(...values)
  return shown.map((record) => {
    const v = value(record)
    const tag = releaseTag(record.ref)
    const role = record.id === pair.b ? 'b' : record.id === pair.a ? 'a' : undefined
    return {
      id: record.id,
      createdAt: record.createdAt,
      ...(v === undefined ? {} : { value: v }),
      text: formatValue(v, metric.unit),
      height:
        v === undefined ? 0 : most === least ? 0.6 : 0.15 + (0.85 * (v - least)) / (most - least),
      ...(tag ? { tag } : {}),
      ...(role ? { role } : {}),
    }
  })
}

/**
 * Search parameters of an analysis record's page: `compare` is the record id to compare with (the
 * A of the version chart; the record itself is B), `view` the tab (Report when absent) and
 * `metric` the metric id the version chart plots.
 */
export interface AnalysisSearch {
  compare?: string
  view?: 'changes' | 'log'
  metric?: string
}

/** `AnalysisSearch` from raw search values; unknown and empty values are dropped. */
export const parseAnalysisSearch = (search: Record<string, unknown>): AnalysisSearch => ({
  ...searchEntry('compare', searchText(search.compare)),
  ...searchEntry('view', searchEnum(search.view, ['changes', 'log'] as const)),
  ...searchEntry('metric', searchText(search.metric)),
})
