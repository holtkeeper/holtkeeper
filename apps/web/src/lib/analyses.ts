import type { AnalysisSummary, Block, Metric } from '@holtkeeper/api'

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

/** Sidebar pages for analysis kinds: route, kind, title, icon and the metrics their trend prefers. */
export const analysisPages = [
  {
    to: '/releases',
    kind: 'changelog',
    title: 'Releases',
    icon: 'release',
    description: 'Commit history and contributors per release',
    trend: [/commits/i, /contributors/i],
  },
  {
    to: '/bundles',
    kind: 'bundle',
    title: 'Bundles',
    icon: 'bundles',
    description: 'Build size per entrypoint and release',
    trend: [/gzip/i, /size/i],
  },
  {
    to: '/dependencies',
    kind: 'depgraph',
    title: 'Dependencies',
    icon: 'updates',
    description: 'Workspace graph, cycles and duplicates',
    trend: [/cycle/i, /duplicate/i],
  },
  {
    to: '/quality',
    kind: 'quality',
    title: 'Code quality',
    icon: 'quality',
    description: 'Lint issues, coverage and suggested fixes',
    trend: [/issues/i, /coverage/i],
  },
  {
    to: '/coverage',
    kind: 'coverage',
    title: 'Test coverage',
    icon: 'quality',
    description: 'Line, function and branch coverage per folder and file',
    trend: [/line coverage/i, /without tests/i],
  },
  {
    to: '/testids',
    kind: 'testids',
    title: 'Test ids',
    icon: 'review',
    description: 'Interactive elements of frontend templates with and without test ids',
    trend: [/with test id/i, /missing/i],
  },
  {
    to: '/branches',
    kind: 'branches',
    title: 'Branches',
    icon: 'repos',
    description: 'Merged, abandoned and stale branches to delete',
    trend: [/clean up/i, /stale/i],
  },
  {
    to: '/ci',
    kind: 'ci-jobs',
    title: 'CI jobs',
    icon: 'release',
    description: 'Job durations, slowdowns and failure rates over time',
    trend: [/pipeline time/i, /failure rate/i],
  },
  {
    to: '/licenses',
    kind: 'licenses',
    title: 'Licenses',
    icon: 'audit',
    description: 'Dependency licenses, policy violations and unknowns',
    trend: [/violations/i, /unknown/i],
  },
  {
    to: '/public-api',
    kind: 'api-surface',
    title: 'Public API',
    icon: 'knowledge',
    description: 'Exports of every package per version, diffs and the MCP endpoint for agents',
    trend: [/documented/i, /exports/i],
  },
] as const

/** The group-scoped `fleet` analysis, shown as a tab of each group rather than a sidebar page. */
export const fleetView = {
  kind: 'fleet',
  title: 'Fleet',
  trend: [/behind-major/i, /drifted/i],
} as const

/** The group-scoped `stack` analysis, shown as a tab of each group next to fleet drift. */
export const stackView = {
  kind: 'stack',
  title: 'Tech stack',
  trend: [/^eol$/i, /behind-major/i],
} as const

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

/** The values of one metric across records, oldest first, skipping records without it. */
export function metricSeries(
  analyses: readonly AnalysisSummary[],
  metricId: string,
): { at: string; value: number }[] {
  return analyses
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap((analysis) => {
      const value = analysis.metrics.find((m) => m.id === metricId)?.value
      return typeof value === 'number' ? [{ at: analysis.createdAt, value }] : []
    })
}

/** `metrics` with `delta` filled in from the same metric of `previous` where it is missing. */
export function withDeltas(metrics: readonly Metric[], previous?: readonly Metric[]): Metric[] {
  return metrics.map((metric) => {
    if (metric.delta !== undefined || typeof metric.value !== 'number') return metric
    const before = previous?.find((m) => m.id === metric.id)?.value
    return typeof before === 'number' ? { ...metric, delta: metric.value - before } : metric
  })
}

/** The newest record of one repository with what the list knows about its history. */
export interface RepoLatest {
  latest: AnalysisSummary
  /** Its metrics with deltas against the repository's record before it. */
  metrics: Metric[]
  /** Records of the repository in the list. */
  count: number
  /** Values of `metricId` across the repository's records, oldest first. */
  series: number[]
}

/**
 * One entry per repository of `analyses` (newest first, as the API lists them): the newest
 * record, deltas against the one before it and the series of `metricId` for a sparkline.
 */
export function latestPerRepo(
  analyses: readonly AnalysisSummary[],
  metricId: string | undefined,
): RepoLatest[] {
  const byRepo = new Map<string, AnalysisSummary[]>()
  for (const analysis of analyses) {
    const key = `${analysis.repo.forge}:${analysis.repo.path}`
    byRepo.set(key, [...(byRepo.get(key) ?? []), analysis])
  }
  return [...byRepo.values()].flatMap((records) => {
    const ordered = records.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    const [latest, previous] = ordered
    if (!latest) return []
    return [
      {
        latest,
        metrics: withDeltas(latest.metrics, previous?.metrics),
        count: ordered.length,
        series: metricId ? metricSeries(ordered, metricId).map((point) => point.value) : [],
      },
    ]
  })
}

/** Section anchor id, safe for `id` attributes and URLs. */
export const sectionAnchor = (id: string): string =>
  `section-${id.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`
