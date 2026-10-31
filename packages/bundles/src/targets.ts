import { z } from 'zod'

import { type BundleData, type Sizes, bundleDataSchema } from './data.ts'

/** Where a target's files came from: a build of the checkout or a package published to a registry. */
export type TargetSource = 'build' | 'package'

/** What a published package weighs on disk, besides what its shipped files measure. */
export interface PackageInfo {
  /** Bytes of every file in the archive, declarations, docs and source maps included. */
  unpacked: number
  /** Files in the archive. */
  files: number
  dependencies: string[]
  peerDependencies: string[]
}

/**
 * One measured thing of a repository: an app build (`app`, or one target per configured build)
 * or one version of a published package. `failed` targets keep the error instead of data, so a
 * release whose build no longer works still shows up in history as a gap.
 */
export interface BundleTarget {
  /** `app`, a configured build name, or the package name. */
  name: string
  source: TargetSource
  /** Package version; absent for builds. */
  version?: string
  /** When the package version was published (ISO 8601); builds use the record's time. */
  at?: string
  status: 'ok' | 'failed'
  /** Last lines of the failure, for `failed` targets. */
  error?: string
  data?: BundleData
  package?: PackageInfo
}

/** Data of one `bundle` record: every target the run measured. */
export interface BundleRecordData {
  targets: BundleTarget[]
}

/** Stored data of the `bundle` kind: records before targets hold one `BundleData`. */
export type BundleAnalysisData = BundleRecordData | BundleData

/** Name of the target a build gets when the configuration names none. */
export const APP_TARGET = 'app'

const packageInfoSchema = z.object({
  unpacked: z.number(),
  files: z.number(),
  dependencies: z.array(z.string()),
  peerDependencies: z.array(z.string()),
})

/** Validates one `BundleTarget`, e.g. read back from a cache. */
export const bundleTargetSchema: z.ZodType<BundleTarget> = z.object({
  name: z.string().min(1),
  source: z.enum(['build', 'package']),
  version: z.string().optional(),
  at: z.string().optional(),
  status: z.enum(['ok', 'failed']),
  error: z.string().optional(),
  data: bundleDataSchema.optional(),
  package: packageInfoSchema.optional(),
})

/** Validates `BundleRecordData`. */
export const bundleRecordSchema: z.ZodType<BundleRecordData> = z.object({
  targets: z.array(bundleTargetSchema),
})

/** Validates either shape of stored `bundle` data. */
export const bundleAnalysisSchema: z.ZodType<BundleAnalysisData> = z.union([
  bundleRecordSchema,
  bundleDataSchema,
])

/**
 * Whether stored data has either shape of the `bundle` kind, judged by its top-level lists only:
 * records are validated on ingest, so this is cheap enough for every record of a history.
 */
export function isBundleAnalysisData(value: unknown): value is BundleAnalysisData {
  if (typeof value !== 'object' || value === null) return false
  return (
    ('targets' in value && Array.isArray(value.targets)) ||
    ('assets' in value && Array.isArray(value.assets) && 'entrypoints' in value)
  )
}

/** The targets of stored data; a record before targets is one `app` build. */
export function bundleTargets(data: BundleAnalysisData): BundleTarget[] {
  if ('targets' in data) return data.targets
  return [{ name: APP_TARGET, source: 'build', status: 'ok', data }]
}

/** Identity of a target across records: the name, and the version for packages. */
export const targetKey = (target: Pick<BundleTarget, 'name' | 'version'>) =>
  target.version ? `${target.name}@${target.version}` : target.name

const zero = (): Sizes => ({ raw: 0, gzip: 0, brotli: 0 })

/** Sizes of every shipped asset of a build. */
export function totalSizes(data: BundleData): Sizes {
  return data.assets.reduce((total, asset) => {
    total.raw += asset.raw
    total.gzip += asset.gzip
    total.brotli += asset.brotli
    return total
  }, zero())
}

/** One target in one record, as a point of its history. */
export interface BundlePoint {
  analysisId: string
  ref?: string
  version?: string
  /** Publish time for package versions, else the record's time. */
  at: string
  status: 'ok' | 'failed'
  error?: string
  total?: Sizes
  /** JS and CSS gzip bytes. */
  js?: number
  css?: number
  /** Initial and lazy sizes per entrypoint. */
  entrypoints?: { name: string; initial: Sizes; lazy: Sizes }[]
  package?: PackageInfo
}

/** The history of one target, oldest point first. */
export interface BundleSeries {
  name: string
  source: TargetSource
  points: BundlePoint[]
}

/** What `bundleSeries` reads of a record. */
export interface BundleRecordLike {
  id: string
  createdAt: string
  ref?: string
  data: BundleAnalysisData
}

const gzipOf = (data: BundleData, kind: 'js' | 'css') =>
  data.assets.filter((asset) => asset.kind === kind).reduce((sum, asset) => sum + asset.gzip, 0)

function pointOf(record: BundleRecordLike, target: BundleTarget): BundlePoint {
  const data = target.data
  return {
    analysisId: record.id,
    ...(record.ref ? { ref: record.ref } : {}),
    ...(target.version ? { version: target.version } : {}),
    at: target.at ?? record.createdAt,
    status: target.status,
    ...(target.error ? { error: target.error } : {}),
    ...(data
      ? {
          total: totalSizes(data),
          js: gzipOf(data, 'js'),
          css: gzipOf(data, 'css'),
          entrypoints: data.entrypoints.map((entry) => ({
            name: entry.name,
            initial: entry.initialSize,
            lazy: entry.lazySize,
          })),
        }
      : {}),
    ...(target.package ? { package: target.package } : {}),
  }
}

/** A target located in the record that holds it. */
export interface LocatedTarget {
  record: BundleRecordLike
  target: BundleTarget
}

/**
 * Every target of the records as a history per target name, sorted by name. A package version
 * measured by several records counts once, from the newest record; builds get one point per
 * record. Points are ordered by `at`.
 */
export function bundleSeries(records: BundleRecordLike[]): BundleSeries[] {
  const located = locateTargets(records)
  const series = new Map<string, BundleSeries>()
  for (const { record, target } of located.values()) {
    const entry = series.get(target.name) ?? {
      name: target.name,
      source: target.source,
      points: [],
    }
    entry.points.push(pointOf(record, target))
    series.set(target.name, entry)
  }
  for (const entry of series.values())
    entry.points.sort(
      (a, b) => a.at.localeCompare(b.at) || a.analysisId.localeCompare(b.analysisId),
    )
  return [...series.values()].toSorted((a, b) => a.name.localeCompare(b.name))
}

const pointId = (record: BundleRecordLike, target: BundleTarget) =>
  target.version ? targetKey(target) : `${target.name}#${record.id}`

/** Targets by point id: `name@version` for packages, `name#analysisId` for builds. */
function locateTargets(records: BundleRecordLike[]): Map<string, LocatedTarget> {
  const found = new Map<string, LocatedTarget>()
  const newestFirst = records.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const record of newestFirst)
    for (const target of bundleTargets(record.data)) {
      const id = pointId(record, target)
      if (!found.has(id)) found.set(id, { record, target })
    }
  return found
}

/**
 * One point of a target's history and the closest earlier point that measured fine, for
 * reports. `version` picks a package version, `analysisId` a build record; without either the
 * newest point. `undefined` when the target has no such point.
 */
export function findTargetPoint(
  records: BundleRecordLike[],
  query: { name: string; version?: string; analysisId?: string },
): { current: LocatedTarget; previous?: LocatedTarget } | undefined {
  const located = [...locateTargets(records).values()]
    .filter(({ target }) => target.name === query.name)
    .toSorted((a, b) =>
      (a.target.at ?? a.record.createdAt).localeCompare(b.target.at ?? b.record.createdAt),
    )
  const index = query.version
    ? located.findIndex(({ target }) => target.version === query.version)
    : query.analysisId
      ? located.findIndex(({ record }) => record.id === query.analysisId)
      : located.length - 1
  const current = located[index]
  if (!current) return undefined
  const previous = located
    .slice(0, index)
    .toReversed()
    .find(({ target }) => target.status === 'ok')
  return { current, ...(previous ? { previous } : {}) }
}
