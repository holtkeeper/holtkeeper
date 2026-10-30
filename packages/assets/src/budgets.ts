import type { Asset, AssetKind, Budget, BudgetViolation, KindTotal, TotalBudgets } from './data.ts'
import { assetKinds } from './data.ts'

/**
 * Bytes and files per kind, in `assetKinds` order, kinds without files left out. A build file
 * whose content equals a source file is the same shipped asset and is not counted again.
 */
export function totalsOf(assets: readonly Asset[]): KindTotal[] {
  const sourceHashes = new Set(
    assets.filter((asset) => asset.origin === 'source').map((asset) => asset.hash),
  )
  const totals = new Map<AssetKind, KindTotal>()
  for (const asset of assets) {
    if (asset.origin === 'build' && sourceHashes.has(asset.hash)) continue
    const total = totals.get(asset.kind) ?? { kind: asset.kind, count: 0, bytes: 0 }
    total.count++
    total.bytes += asset.bytes
    totals.set(asset.kind, total)
  }
  return assetKinds.flatMap((kind) => {
    const total = totals.get(kind)
    return total ? [total] : []
  })
}

const dimensionsOf = (asset: Asset) => asset.image ?? asset.video

/**
 * Every limit an asset or kind total exceeds. An asset matching several budgets is checked
 * against each; ids are stable across runs so reports can tell new violations from old ones.
 */
export function evaluateBudgets(
  assets: readonly Asset[],
  budgets: readonly Budget[],
  total: TotalBudgets = {},
): BudgetViolation[] {
  const violations: BudgetViolation[] = []
  for (const budget of budgets) {
    const glob = new Bun.Glob(budget.pattern)
    for (const asset of assets) {
      if (budget.kind && asset.kind !== budget.kind) continue
      if (!glob.match(asset.path)) continue
      const size = dimensionsOf(asset)
      const checks: [BudgetViolation['limit'], number | undefined, number | undefined][] = [
        ['bytes', asset.bytes, budget.maxBytes],
        ['width', size?.width, budget.maxWidth],
        ['height', size?.height, budget.maxHeight],
      ]
      for (const [limit, actual, max] of checks) {
        if (actual === undefined || max === undefined || actual <= max) continue
        violations.push({
          id: `${limit}:${budget.pattern}:${asset.path}`,
          path: asset.path,
          pattern: budget.pattern,
          ...(budget.kind ? { kind: budget.kind } : {}),
          limit,
          actual,
          max,
        })
      }
    }
  }
  for (const kindTotal of totalsOf(assets)) {
    const max = total[kindTotal.kind]
    if (max === undefined || kindTotal.bytes <= max) continue
    violations.push({
      id: `total:${kindTotal.kind}`,
      kind: kindTotal.kind,
      limit: 'total',
      actual: kindTotal.bytes,
      max,
    })
  }
  return violations
}

/** Distinct assets and kinds over budget. */
export const overBudgetCount = (violations: readonly BudgetViolation[]) =>
  new Set(violations.map((violation) => violation.path ?? `total:${violation.kind}`)).size
