import { totalsOf } from './budgets.ts'
import type { Asset, AssetKind, AssetsData } from './data.ts'
import { assetKinds } from './data.ts'

export type AssetChangeStatus = 'added' | 'removed' | 'grown' | 'shrunk' | 'renamed' | 'changed'

/** One asset that differs between two records. */
export interface AssetChange {
  status: AssetChangeStatus
  path: string
  kind: AssetKind
  /** Path in the previous record, for `renamed`. */
  previousPath?: string
  previousBytes?: number
  bytes?: number
  /** `bytes - previousBytes`, a missing side counting as zero. */
  delta: number
}

export interface KindChange {
  kind: AssetKind
  previous: number
  current: number
  delta: number
  previousCount: number
  currentCount: number
}

/** What changed between two records. `assets` is sorted by the largest absolute delta. */
export interface AssetComparison {
  kinds: KindChange[]
  total: { previous: number; current: number; delta: number }
  assets: AssetChange[]
  /** Budget violation ids present now but not before, and the other way round. */
  newViolations: string[]
  resolvedViolations: string[]
}

/**
 * Compares two records. Assets match by path; an unmatched current asset whose content hash
 * equals an unmatched previous one is a rename. Same-size assets with new content are `changed`.
 */
export function compareAssets(previous: AssetsData, current: AssetsData): AssetComparison {
  const before = new Map(previous.assets.map((asset) => [asset.path, asset]))
  const after = new Map(current.assets.map((asset) => [asset.path, asset]))
  const changes: AssetChange[] = []
  const added: Asset[] = []
  for (const asset of current.assets) {
    const old = before.get(asset.path)
    if (!old) {
      added.push(asset)
      continue
    }
    if (old.hash === asset.hash) continue
    const delta = asset.bytes - old.bytes
    changes.push({
      status: delta > 0 ? 'grown' : delta < 0 ? 'shrunk' : 'changed',
      path: asset.path,
      kind: asset.kind,
      previousBytes: old.bytes,
      bytes: asset.bytes,
      delta,
    })
  }
  const removedByHash = new Map<string, Asset[]>()
  for (const asset of previous.assets) {
    if (after.has(asset.path)) continue
    removedByHash.set(asset.hash, [...(removedByHash.get(asset.hash) ?? []), asset])
  }
  for (const asset of added) {
    const old = removedByHash.get(asset.hash)?.shift()
    changes.push(
      old
        ? {
            status: 'renamed',
            path: asset.path,
            kind: asset.kind,
            previousPath: old.path,
            previousBytes: old.bytes,
            bytes: asset.bytes,
            delta: 0,
          }
        : {
            status: 'added',
            path: asset.path,
            kind: asset.kind,
            bytes: asset.bytes,
            delta: asset.bytes,
          },
    )
  }
  for (const asset of [...removedByHash.values()].flat()) {
    changes.push({
      status: 'removed',
      path: asset.path,
      kind: asset.kind,
      previousBytes: asset.bytes,
      delta: -asset.bytes,
    })
  }
  const previousTotals = new Map(totalsOf(previous.assets).map((total) => [total.kind, total]))
  const currentTotals = new Map(totalsOf(current.assets).map((total) => [total.kind, total]))
  const kinds = assetKinds.flatMap((kind): KindChange[] => {
    const was = previousTotals.get(kind)
    const now = currentTotals.get(kind)
    if (!was && !now) return []
    return [
      {
        kind,
        previous: was?.bytes ?? 0,
        current: now?.bytes ?? 0,
        delta: (now?.bytes ?? 0) - (was?.bytes ?? 0),
        previousCount: was?.count ?? 0,
        currentCount: now?.count ?? 0,
      },
    ]
  })
  const sum = (key: 'previous' | 'current') => kinds.reduce((total, kind) => total + kind[key], 0)
  const previousIds = new Set(previous.budgets.map((violation) => violation.id))
  const currentIds = new Set(current.budgets.map((violation) => violation.id))
  return {
    kinds,
    total: {
      previous: sum('previous'),
      current: sum('current'),
      delta: sum('current') - sum('previous'),
    },
    assets: changes.toSorted(
      (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.path.localeCompare(b.path),
    ),
    newViolations: [...currentIds].filter((id) => !previousIds.has(id)),
    resolvedViolations: [...previousIds].filter((id) => !currentIds.has(id)),
  }
}
