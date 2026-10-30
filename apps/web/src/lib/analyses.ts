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
] as const satisfies readonly Block['type'][]

type MissingBlock = Exclude<Block['type'], (typeof blockTypes)[number]>
const exhaustive: MissingBlock extends never ? true : never = true
void exhaustive

/** Sidebar pages for analysis kinds: route, kind, title and the metrics their trend prefers. */
export const analysisPages = [
  {
    to: '/releases',
    kind: 'changelog',
    title: 'Releases',
    description: 'Commit history and contributors per release',
    trend: [/commits/i, /contributors/i],
  },
  {
    to: '/bundles',
    kind: 'bundle',
    title: 'Bundles',
    description: 'Build size per entrypoint and release',
    trend: [/gzip/i, /size/i],
  },
  {
    to: '/dependencies',
    kind: 'depgraph',
    title: 'Dependencies',
    description: 'Workspace graph, cycles and duplicates',
    trend: [/cycle/i, /duplicate/i],
  },
  {
    to: '/quality',
    kind: 'quality',
    title: 'Code quality',
    description: 'Lint issues, coverage and suggested fixes',
    trend: [/issues/i, /coverage/i],
  },
] as const

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

/** Section anchor id, safe for `id` attributes and URLs. */
export const sectionAnchor = (id: string): string =>
  `section-${id.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`
