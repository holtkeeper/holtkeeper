import { type RepoTarget, type Scope, scopeCoversRepo } from '@holtkeeper/access'
import type {
  ActivityStore,
  AiUsageRecord,
  AiUsageStore,
  SettingEntry,
  SettingStore,
} from '@holtkeeper/store'
import { z } from 'zod'

import { type BudgetPeriod, periodRange, projectMonthEnd } from './period.ts'

/** Setting key holding budgets. */
export const budgetKey = 'llm.budget'

/** Value of an `llm.budget` setting. Same shape as the definition in `@holtkeeper/settings`. */
export const budgetSchema = z.object({
  monthlyUsd: z.number().positive().optional(),
  dailyUsd: z.number().positive().optional(),
  action: z.enum(['warn', 'block']),
  /** Monthly USD limit per task kind. */
  perTaskKind: z.record(z.string().min(1), z.number().positive()).optional(),
})

export type Budget = z.infer<typeof budgetSchema>

/** A budget as stored: the setting entry's id and scope with its parsed value. */
export interface ScopedBudget {
  id: string
  scope: Scope
  budget: Budget
  updatedAt: string
}

/** One limit of one budget and how much of it is used in the current period. */
export interface BudgetLimitStatus {
  budgetId: string
  scope: Scope
  action: Budget['action']
  period: BudgetPeriod
  /** Set for `perTaskKind` limits. */
  taskKind?: string
  limitUsd: number
  spentUsd: number
}

/** What a budget check decided for a run that is about to start. */
export interface BudgetDecision {
  allowed: boolean
  /** Every limit already reached, warn and block alike. */
  exceeded: BudgetLimitStatus[]
}

export interface BudgetCheck {
  repo: RepoTarget
  taskKind: string
}

/** Decides whether a run may start and keeps cached spend current as runs are recorded. */
export interface BudgetGuard {
  check(run: BudgetCheck): Promise<BudgetDecision>
  /** Counts a just-recorded run in the cached spend so the cache does not lag behind. */
  note(record: Omit<AiUsageRecord, 'id'>): void
}

const hasWildcard = (pattern: string) => /[*?[\]{}]/.test(pattern)

/** Same ranking as `@holtkeeper/settings`: all (0) < groups (1) < globs (2) < exact paths (3). */
const specificity = (scope: Scope) =>
  scope.repos?.some((pattern) => !hasWildcard(pattern))
    ? 3
    : scope.repos?.length
      ? 2
      : scope.groups?.length
        ? 1
        : 0

/** Valid `llm.budget` entries; entries whose value does not parse are skipped. */
export function parseBudgets(entries: readonly SettingEntry[]): ScopedBudget[] {
  return entries.flatMap((entry) => {
    if (entry.key !== budgetKey) return []
    const parsed = budgetSchema.safeParse(entry.value)
    return parsed.success
      ? [{ id: entry.id, scope: entry.scope, budget: parsed.data, updatedAt: entry.updatedAt }]
      : []
  })
}

/**
 * The budgets that apply to a repository: the most specific one covering it (newest among equally
 * specific ones), plus the newest global (`all`) budget when that is a different one.
 */
export function applicableBudgets(
  budgets: readonly ScopedBudget[],
  repo: RepoTarget,
): ScopedBudget[] {
  const newest = (a: ScopedBudget, b: ScopedBudget) => b.updatedAt.localeCompare(a.updatedAt)
  const specific = budgets
    .filter((b) => scopeCoversRepo(b.scope, repo))
    .toSorted((a, b) => specificity(b.scope) - specificity(a.scope) || newest(a, b))[0]
  const global = budgets.filter((b) => b.scope.all).toSorted(newest)[0]
  return [specific, global].filter(
    (b, index, all): b is ScopedBudget => b !== undefined && all.indexOf(b) === index,
  )
}

/** The limits a budget sets for a run of `taskKind` (every task kind when omitted). */
export function budgetLimits(
  budget: Budget,
  taskKind?: string,
): { period: BudgetPeriod; limitUsd: number; taskKind?: string }[] {
  const limits: { period: BudgetPeriod; limitUsd: number; taskKind?: string }[] = []
  if (budget.monthlyUsd !== undefined) limits.push({ period: 'month', limitUsd: budget.monthlyUsd })
  if (budget.dailyUsd !== undefined) limits.push({ period: 'day', limitUsd: budget.dailyUsd })
  for (const [kind, limitUsd] of Object.entries(budget.perTaskKind ?? {}))
    if (taskKind === undefined || kind === taskKind)
      limits.push({ period: 'month', limitUsd, taskKind: kind })
  return limits
}

/** Whether a limit stops runs: the spend already reached it. */
export const limitReached = (status: Pick<BudgetLimitStatus, 'limitUsd' | 'spentUsd'>) =>
  status.spentUsd >= status.limitUsd

export interface BudgetGuardOptions {
  settings: Pick<SettingStore, 'list'>
  usage: Pick<AiUsageStore, 'aggregate'>
  /** Receives `ai.budget.exceeded` once per limit and period. */
  activity?: Pick<ActivityStore, 'append'>
  now?: () => Date
  /** How long computed spend is reused. Default 30 seconds. */
  cacheMs?: number
}

/** Spend of a scope in a period, from `aggregate`. */
async function spendOf(
  usage: Pick<AiUsageStore, 'aggregate'>,
  scope: Scope,
  range: { from: string; to: string },
  taskKind?: string,
): Promise<number> {
  const [bucket] = await usage.aggregate({
    from: range.from,
    to: range.to,
    filter: { scopes: [scope], ...(taskKind !== undefined && { taskKind }) },
  })
  return bucket?.costUsd ?? 0
}

/**
 * Checks budgets from the `llm.budget` settings against recorded spend. Spend per limit is cached
 * for `cacheMs` and bumped by `note`, so a burst of runs costs one aggregate per limit. A `warn`
 * limit only reports; a reached `block` limit denies. The activity event is deduplicated in
 * process memory, so a restart may emit it once more in the same period.
 */
export function budgetGuard({
  settings,
  usage,
  activity,
  now = () => new Date(),
  cacheMs = 30_000,
}: BudgetGuardOptions): BudgetGuard {
  const cache = new Map<
    string,
    { spent: number; expires: number; scope: Scope; from: string; to: string; taskKind?: string }
  >()
  const reported = new Set<string>()

  async function spent(
    budget: ScopedBudget,
    period: BudgetPeriod,
    at: Date,
    taskKind?: string,
  ): Promise<number> {
    const range = periodRange(period, at)
    const id = JSON.stringify([budget.scope, period, range.key, taskKind ?? null])
    const hit = cache.get(id)
    if (hit && hit.expires > at.getTime()) return hit.spent
    const value = await spendOf(usage, budget.scope, range, taskKind)
    cache.set(id, {
      spent: value,
      expires: at.getTime() + cacheMs,
      scope: budget.scope,
      from: range.from,
      to: range.to,
      ...(taskKind !== undefined && { taskKind }),
    })
    return value
  }

  return {
    async check({ repo, taskKind }) {
      const at = now()
      const budgets = applicableBudgets(parseBudgets(await settings.list(budgetKey)), repo)
      const exceeded: BudgetLimitStatus[] = []
      for (const scoped of budgets) {
        for (const limit of budgetLimits(scoped.budget, taskKind)) {
          const status: BudgetLimitStatus = {
            budgetId: scoped.id,
            scope: scoped.scope,
            action: scoped.budget.action,
            ...limit,
            spentUsd: await spent(scoped, limit.period, at, limit.taskKind),
          }
          if (!limitReached(status)) continue
          exceeded.push(status)
          const once = JSON.stringify([
            status.budgetId,
            status.period,
            status.taskKind ?? null,
            periodRange(status.period, at).key,
          ])
          if (activity && !reported.has(once)) {
            reported.add(once)
            await activity.append({
              at: at.toISOString(),
              actor: 'system',
              action: 'ai.budget.exceeded',
              subject: status.budgetId,
              details: { ...status, repo: `${repo.forge}:${repo.path}` },
            })
          }
        }
      }
      return { allowed: !exceeded.some((s) => s.action === 'block'), exceeded }
    },
    note(record) {
      for (const entry of cache.values()) {
        if (record.at < entry.from || record.at >= entry.to) continue
        if (entry.taskKind !== undefined && entry.taskKind !== record.taskKind) continue
        if (!scopeCoversRepo(entry.scope, { ...record.repo, groups: record.groups })) continue
        entry.spent += record.costUsd
      }
    },
  }
}

/** Usage of one limit for display: share used and, for monthly limits, projected month-end spend. */
export interface BudgetLimitView {
  period: BudgetPeriod
  taskKind?: string
  limitUsd: number
  spentUsd: number
  /** `spentUsd / limitUsd * 100`. */
  percent: number
  /** Monthly limits only. */
  projectedUsd?: number
}

/** A budget with the state of each of its limits. */
export interface BudgetStatus {
  id: string
  scope: Scope
  action: Budget['action']
  limits: BudgetLimitView[]
}

/** Current state of every valid budget among `entries`, at `now`. */
export async function budgetStatuses(
  entries: readonly SettingEntry[],
  usage: Pick<AiUsageStore, 'aggregate'>,
  now: Date,
): Promise<BudgetStatus[]> {
  return Promise.all(
    parseBudgets(entries).map(async (scoped) => ({
      id: scoped.id,
      scope: scoped.scope,
      action: scoped.budget.action,
      limits: await Promise.all(
        budgetLimits(scoped.budget).map(async (limit) => {
          const spentUsd = await spendOf(
            usage,
            scoped.scope,
            periodRange(limit.period, now),
            limit.taskKind,
          )
          return {
            ...limit,
            spentUsd,
            percent: (spentUsd / limit.limitUsd) * 100,
            ...(limit.period === 'month' && { projectedUsd: projectMonthEnd(spentUsd, now) }),
          }
        }),
      ),
    })),
  )
}
