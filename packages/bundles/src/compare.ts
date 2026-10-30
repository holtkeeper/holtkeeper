import type { AssetKind, BundleAsset, BundleData, BundlePackage, Sizes } from './data.ts'

/** Sizes before and after; a side is missing when the item exists in only one build. */
export interface SizeChange {
  previous?: Sizes
  current?: Sizes
  /** `current - previous`, treating a missing side as zero. */
  delta: Sizes
}

export type ChangeStatus = 'added' | 'removed' | 'changed' | 'unchanged'

export interface EntrypointChange extends SizeChange {
  name: string
  status: ChangeStatus
  /** Change of the lazy assets; the top-level sizes are the initial load. */
  lazy: SizeChange
}

/** An asset matched across builds by its normalized name. */
export interface AssetChange extends SizeChange {
  name: string
  kind: AssetKind
  status: ChangeStatus
  previousFile?: string
  currentFile?: string
}

export type PackageStatus = 'added' | 'removed' | 'grown' | 'shrunk' | 'unchanged'

export interface PackageChange {
  name: string
  status: PackageStatus
  previous?: { bytes: number; gzip: number }
  current?: { bytes: number; gzip: number }
  delta: { bytes: number; gzip: number }
  /** Versions or install paths present now but not before. */
  addedVersions: string[]
  /** The package is bundled from more than one version or install path now but was not before. */
  newlyDuplicated: boolean
}

/** What changed between two builds. Every list is sorted by the largest absolute gzip change. */
export interface BundleComparison {
  entrypoints: EntrypointChange[]
  assets: AssetChange[]
  packages: PackageChange[]
  totals: { all: SizeChange; js: SizeChange; css: SizeChange }
}

const zero = (): Sizes => ({ raw: 0, gzip: 0, brotli: 0 })
const sizesOf = (value: Sizes): Sizes => ({
  raw: value.raw,
  gzip: value.gzip,
  brotli: value.brotli,
})

function change(previous: Sizes | undefined, current: Sizes | undefined): SizeChange {
  const before = previous ?? zero()
  const after = current ?? zero()
  return {
    ...(previous ? { previous: sizesOf(previous) } : {}),
    ...(current ? { current: sizesOf(current) } : {}),
    delta: {
      raw: after.raw - before.raw,
      gzip: after.gzip - before.gzip,
      brotli: after.brotli - before.brotli,
    },
  }
}

const statusOf = (sizes: SizeChange): ChangeStatus =>
  !sizes.previous
    ? 'added'
    : !sizes.current
      ? 'removed'
      : sizes.delta.raw === 0
        ? 'unchanged'
        : 'changed'

const sumAssets = (assets: BundleAsset[], kind?: AssetKind) =>
  assets
    .filter((asset) => !kind || asset.kind === kind)
    .reduce((total, asset) => {
      total.raw += asset.raw
      total.gzip += asset.gzip
      total.brotli += asset.brotli
      return total
    }, zero())

const byChange = <T extends { name: string; delta: { gzip: number } }>(a: T, b: T) =>
  Math.abs(b.delta.gzip) - Math.abs(a.delta.gzip) || a.name.localeCompare(b.name)

const keys = <T>(...maps: Map<string, T>[]) => [...new Set(maps.flatMap((map) => [...map.keys()]))]

const variants = (pkg: BundlePackage) => (pkg.versions.length ? pkg.versions : pkg.instances)

/** Diffs two analyses. Pure: the inputs are not changed. */
export function compareBundles(previous: BundleData, current: BundleData): BundleComparison {
  const beforeEntries = new Map(previous.entrypoints.map((entry) => [entry.name, entry]))
  const afterEntries = new Map(current.entrypoints.map((entry) => [entry.name, entry]))
  const entrypoints = keys(beforeEntries, afterEntries)
    .map((name): EntrypointChange => {
      const before = beforeEntries.get(name)
      const after = afterEntries.get(name)
      const initial = change(before?.initialSize, after?.initialSize)
      const lazy = change(before?.lazySize, after?.lazySize)
      const status = statusOf(initial)
      return {
        name,
        ...initial,
        status: status === 'unchanged' && lazy.delta.raw !== 0 ? 'changed' : status,
        lazy,
      }
    })
    .toSorted(byChange)

  const beforeAssets = new Map(previous.assets.map((asset) => [asset.name, asset]))
  const afterAssets = new Map(current.assets.map((asset) => [asset.name, asset]))
  const assets = keys(beforeAssets, afterAssets)
    .map((name): AssetChange => {
      const before = beforeAssets.get(name)
      const after = afterAssets.get(name)
      const sizes = change(before, after)
      const changed = statusOf(sizes)
      return {
        name,
        kind: (after ?? before)?.kind ?? 'other',
        ...sizes,
        status: changed === 'unchanged' && before?.file !== after?.file ? 'changed' : changed,
        ...(before ? { previousFile: before.file } : {}),
        ...(after ? { currentFile: after.file } : {}),
      }
    })
    .toSorted(byChange)

  const beforePackages = new Map(previous.packages.map((pkg) => [pkg.name, pkg]))
  const afterPackages = new Map(current.packages.map((pkg) => [pkg.name, pkg]))
  const packages = keys(beforePackages, afterPackages)
    .map((name): PackageChange => {
      const before = beforePackages.get(name)
      const after = afterPackages.get(name)
      const delta = {
        bytes: (after?.bytes ?? 0) - (before?.bytes ?? 0),
        gzip: (after?.gzip ?? 0) - (before?.gzip ?? 0),
      }
      const status: PackageStatus = !before
        ? 'added'
        : !after
          ? 'removed'
          : delta.bytes > 0
            ? 'grown'
            : delta.bytes < 0
              ? 'shrunk'
              : 'unchanged'
      const known = new Set(before ? variants(before) : [])
      const now = after ? variants(after) : []
      return {
        name,
        status,
        ...(before ? { previous: { bytes: before.bytes, gzip: before.gzip } } : {}),
        ...(after ? { current: { bytes: after.bytes, gzip: after.gzip } } : {}),
        delta,
        addedVersions: before ? now.filter((variant) => !known.has(variant)) : [],
        newlyDuplicated: now.length > 1 && known.size <= 1,
      }
    })
    .toSorted(byChange)

  return {
    entrypoints,
    assets,
    packages,
    totals: {
      all: change(sumAssets(previous.assets), sumAssets(current.assets)),
      js: change(sumAssets(previous.assets, 'js'), sumAssets(current.assets, 'js')),
      css: change(sumAssets(previous.assets, 'css'), sumAssets(current.assets, 'css')),
    },
  }
}
