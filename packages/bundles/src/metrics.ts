import type { MetricsContext } from '@holtkeeper/report'
import { z } from 'zod'

import type { BundleData } from './data.ts'
import { type BundleAnalysisData, type TargetSource, bundleTargets } from './targets.ts'
import { compareVersions } from './version.ts'

/** Share of a budget from which a target counts as near it. */
const NEAR_BUDGET = 0.9

/**
 * The `budgets` option of the `bundle` analyzer: maximum JS and CSS gzip bytes per target, keyed
 * by target name or a glob over target names (`app`, `@acme/*`).
 */
export const bundleBudgetsSchema = z.record(z.string().min(1), z.coerce.number().int().positive())

/** Where a target stands against its budget: `near` from 90% of it, `over` above it. */
export type BudgetVerdict = 'ok' | 'near' | 'over'

/** Stored numbers of one target: the newest version of a package, or one build. */
export interface BundleTargetMetrics {
  name: string
  source: TargetSource
  version?: string
  status: 'ok' | 'failed'
  /** JS and CSS gzip bytes of every asset. */
  gzip?: number
  /** Initial gzip bytes of the largest entrypoint. */
  initial?: number
  /** `gzip` minus the previous record's for the same target name. */
  delta?: number
  /** Maximum gzip bytes from the `budgets` option. */
  budget?: number
  verdict?: BudgetVerdict
}

/** Stored headline numbers of one `bundle` record. */
export interface BundleMetrics {
  /** One entry per target name, sorted by name. */
  targets: BundleTargetMetrics[]
  /** Targets whose build or download failed. */
  failed: number
}

const gzipOf = (data: BundleData) =>
  data.assets
    .filter((asset) => asset.kind === 'js' || asset.kind === 'css')
    .reduce((sum, asset) => sum + asset.gzip, 0)

const budgetsOf = (options: unknown): Record<string, number> => {
  const value =
    typeof options === 'object' && options !== null && 'budgets' in options
      ? options.budgets
      : undefined
  return bundleBudgetsSchema.safeParse(value).data ?? {}
}

/** The budget of target `name` in `budgets`: an exact name wins, then the first matching glob. */
export function budgetFor(budgets: Record<string, number>, name: string): number | undefined {
  if (Object.hasOwn(budgets, name)) return budgets[name]
  for (const [pattern, max] of Object.entries(budgets))
    if (new Bun.Glob(pattern).match(name)) return max
  return undefined
}

/** Where `gzip` bytes stand against `budget`. */
export const budgetVerdict = (gzip: number, budget: number): BudgetVerdict =>
  gzip > budget ? 'over' : gzip >= budget * NEAR_BUDGET ? 'near' : 'ok'

/**
 * The budget and verdict of a stored target judged by the current `budgets` option: when `budgets`
 * is given (the option is set), its budget for the target's name; otherwise the budget stored with
 * the target. No verdict without both a budget and a size.
 */
export function judgeTarget(
  target: Pick<BundleTargetMetrics, 'name' | 'gzip' | 'budget'>,
  budgets: Record<string, number> | undefined,
): { budget?: number; verdict?: BudgetVerdict } {
  const budget = budgets ? budgetFor(budgets, target.name) : target.budget
  if (budget === undefined) return {}
  return target.gzip === undefined
    ? { budget }
    : { budget, verdict: budgetVerdict(target.gzip, budget) }
}

/**
 * `BundleMetrics` of stored `bundle` data: per target name its gzip size, delta against
 * `previous` and verdict against `options.budgets`.
 */
export function bundleMetrics(
  data: BundleAnalysisData,
  { options, previous }: MetricsContext<BundleMetrics> = {},
): BundleMetrics {
  const budgets = budgetsOf(options)
  const newest = new Map<string, ReturnType<typeof bundleTargets>[number]>()
  for (const target of bundleTargets(data)) {
    const current = newest.get(target.name)
    if (
      !current ||
      (target.version && current.version && compareVersions(target.version, current.version) > 0)
    )
      newest.set(target.name, target)
  }
  const before = new Map(previous?.targets.map((target) => [target.name, target.gzip]))
  const targets = [...newest.values()]
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((target): BundleTargetMetrics => {
      const gzip = target.data ? gzipOf(target.data) : undefined
      const initial = target.data?.entrypoints.reduce(
        (max, entry) => Math.max(max, entry.initialSize.gzip),
        0,
      )
      const was = before.get(target.name)
      const budget = budgetFor(budgets, target.name)
      return {
        name: target.name,
        source: target.source,
        ...(target.version ? { version: target.version } : {}),
        status: target.status,
        ...(gzip === undefined ? {} : { gzip }),
        ...(initial === undefined ? {} : { initial }),
        ...(gzip !== undefined && was !== undefined ? { delta: gzip - was } : {}),
        ...(budget === undefined ? {} : { budget }),
        ...(budget !== undefined && gzip !== undefined
          ? { verdict: budgetVerdict(gzip, budget) }
          : {}),
      }
    })
  return { targets, failed: targets.filter((target) => target.status === 'failed').length }
}
