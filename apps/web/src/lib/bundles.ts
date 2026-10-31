import type { BundlePoint, BundleSeries } from '@holtkeeper/api'

/** Which size a bundle chart and table show. */
export type Compression = 'gzip' | 'brotli' | 'raw'

/** Entrypoints drawn as their own lines; with more, only the largest ones are. */
const MAX_ENTRY_LINES = 6

/** A point's short name: the package version, else the ref (commits shortened), else the date. */
export function pointLabel(point: BundlePoint): string {
  if (point.version) return point.version
  if (point.ref) return /^[0-9a-f]{40}$/.test(point.ref) ? point.ref.slice(0, 8) : point.ref
  return (point.at ?? point.measuredAt).slice(0, 10)
}

/** Search parameters that select a point: the version for packages, the record for builds. */
export const pointSearch = (point: BundlePoint) =>
  point.version ? { version: point.version } : { analysis: point.analysisId }

const lastOk = (points: BundlePoint[]) => points.findLast((point) => point.status === 'ok')

/** One row of the target list. */
export interface TargetRow {
  name: string
  source: BundleSeries['source']
  /** Newest point, measured or not. */
  latest: BundlePoint | undefined
  size: number | undefined
  /** Change of the newest measured point against the measured point before it. */
  delta: number | undefined
  points: number
  failed: boolean
}

/** The target list: newest size and its change per target, largest first. */
export function targetRows(series: BundleSeries[], compression: Compression): TargetRow[] {
  return series
    .map((entry): TargetRow => {
      const measured = entry.points.filter((point) => point.status === 'ok')
      const current = measured.at(-1)
      const before = measured.at(-2)
      const size = current?.total?.[compression]
      const previous = before?.total?.[compression]
      const latest = entry.points.at(-1)
      return {
        name: entry.name,
        source: entry.source,
        latest,
        size,
        delta: size !== undefined && previous !== undefined ? size - previous : undefined,
        points: entry.points.length,
        failed: latest?.status === 'failed',
      }
    })
    .toSorted((a, b) => (b.size ?? -1) - (a.size ?? -1) || a.name.localeCompare(b.name))
}

/** Entrypoints worth a line of their own: the largest by their newest initial size. */
export function chartEntrypoints(series: BundleSeries, compression: Compression): string[] {
  const newest = lastOk(series.points)
  const sizes = new Map<string, number>()
  for (const point of series.points)
    for (const entry of point.entrypoints ?? [])
      if (!sizes.has(entry.name) || point === newest)
        sizes.set(entry.name, entry.initial[compression])
  return [...sizes]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_ENTRY_LINES)
    .map(([name]) => name)
}

/** One chart row per point; sizes of failed points are `null`, so lines show a gap. */
export interface ChartRow {
  key: string
  label: string
  /** Publish or build time, when known. */
  at?: string
  status: BundlePoint['status']
  total: number | null
  [entrypoint: `entry:${string}`]: number | null
}

/** Rows for the history chart of one target: total size and initial size per entrypoint. */
export function chartRows(
  series: BundleSeries,
  compression: Compression,
  entrypoints: string[],
): ChartRow[] {
  return series.points.map((point) => {
    const row: ChartRow = {
      key: point.version ?? point.analysisId,
      label: pointLabel(point),
      ...(point.at ? { at: point.at } : {}),
      status: point.status,
      total: point.total?.[compression] ?? null,
    }
    for (const name of entrypoints) {
      const entry = point.entrypoints?.find((item) => item.name === name)
      row[`entry:${name}`] = entry ? entry.initial[compression] : null
    }
    return row
  })
}

/** Change from the first to the newest measured point, for the chart's caption. */
export function overallChange(series: BundleSeries, compression: Compression) {
  const measured = series.points.filter((point) => point.status === 'ok')
  const first = measured[0]?.total?.[compression]
  const last = measured.at(-1)?.total?.[compression]
  if (first === undefined || last === undefined) return undefined
  return { first, last, delta: last - first, measured: measured.length }
}
