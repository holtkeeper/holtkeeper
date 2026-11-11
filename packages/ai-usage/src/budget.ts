import { type RepoTarget, type Scope, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import {
  type AiUsageRecord,
  type AiUsageStore,
  type AuditStore,
  type SettingEntry,
  type SettingStore,
  SYSTEM_ACTOR,
} from '@holtkeeper/store'
import { z } from 'zod'

import { type PeriodRange, instanceTimeZone, projectPeriodEnd, weekRange } from './period.ts'

/** Setting key holding budgets. */
export const budgetKey = 'llm.budget'

/** Weekly spend limit when a budget does not set one. */
export const DEFAULT_WEEKLY_USD = 150

/** Part of the weekly limit kept for interactive work when a budget does not set one. */
export const DEFAULT_RESERVE_USD = 25

/** Value of an `llm.budget` setting. Same shape as the definition in `@holtkeeper/settings`. */
export const budgetSchema = z.object({
  weeklyUsd: z.number().positive().default(DEFAULT_WEEKLY_USD),
  /** Capped at `weeklyUsd`: a reserve as large as the budget leaves automatic work nothing. */
  reserveUsd: z.number().min(0).default(DEFAULT_RESERVE_USD),
  action: z.enum(['block', 'warn']).default('block'),
})

export type Budget = z.infer<typeof budgetSchema>

/** Id of the budget that applies to everything when no valid global `llm.budget` entry exists. */
export const DEFAULT_BUDGET_ID = 'default'

/** A budget as stored: the setting entry's id and scope with its parsed value. */
export interface ScopedBudget {
  id: string
  scope: Scope
  budget: Budget
  updatedAt: string
}

/** One budget a run would exceed, with the numbers that decided it. */
export interface BudgetLimitStatus {
  budgetId: string
  scope: Scope
  action: Budget['action']
  /** Monday the week started, in the instance time zone (`2026-11-09`). */
  week: string
  weeklyUsd: number
  reserveUsd: number
  /** What the run may bring spend up to: `weeklyUsd`, minus `reserveUsd` for automatic work. */
  limitUsd: number
  spentUsd: number
  /** Expected cost of the run that was checked. */
  estimateUsd: number
  interactive: boolean
}

/** What a budget check decided for a run that is about to start. */
export interface BudgetDecision {
  allowed: boolean
  /** Every budget the run would exceed, warn and block alike. */
  exceeded: BudgetLimitStatus[]
  /**
   * USD the run may spend before a `block` budget's limit is reached; absent when no `block`
   * budget applies. Agents stop a run once it spends this much.
   */
  remainingUsd?: number
}

export interface BudgetCheck {
  repo: RepoTarget
  taskKind: string
  /**
   * A person started the work (a click in the panel, chat, a command on a merge request): it may
   * spend the reserve. Automatic work (schedules, triggers, webhooks) may not. Default `false`.
   */
  interactive?: boolean
  /** Expected cost of the run; default the mean cost of this week's runs of `taskKind`. */
  estimateUsd?: number
}

/** Decides whether a run may start and keeps cached spend current as runs are recorded. */
export interface BudgetGuard {
  check(run: BudgetCheck): Promise<BudgetDecision>
  /** Counts a just-recorded run in the cached spend so the cache does not lag behind. */
  note(record: Omit<AiUsageRecord, 'id'>): void
}

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

/** The default budget for everything, used when no valid global entry exists. */
export const defaultBudget = (): ScopedBudget => ({
  id: DEFAULT_BUDGET_ID,
  scope: { all: true },
  budget: budgetSchema.parse({}),
  updatedAt: '1970-01-01T00:00:00.000Z',
})

/** `budgets` plus `defaultBudget()` when none of them is global. */
export const withDefaultBudget = (budgets: readonly ScopedBudget[]): ScopedBudget[] =>
  budgets.some((b) => b.scope.all) ? [...budgets] : [...budgets, defaultBudget()]

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
    .toSorted((a, b) => scopeSpecificity(b.scope) - scopeSpecificity(a.scope) || newest(a, b))[0]
  const global = budgets.filter((b) => b.scope.all).toSorted(newest)[0]
  return [specific, global].filter(
    (b, index, all): b is ScopedBudget => b !== undefined && all.indexOf(b) === index,
  )
}

/** What a run may bring a budget's weekly spend up to. */
export const limitFor = (budget: Budget, interactive: boolean) =>
  interactive ? budget.weeklyUsd : Math.max(budget.weeklyUsd - budget.reserveUsd, 0)

export interface BudgetGuardOptions {
  settings: Pick<SettingStore, 'list'>
  usage: Pick<AiUsageStore, 'aggregate'>
  /** Receives an `ai.budget_exceeded` event once per budget, week and kind of work. */
  audit?: Pick<AuditStore, 'append'>
  now?: () => Date
  /** Where weeks start on Monday 00:00. Default: the instance time zone. */
  timeZone?: string
  /** How long computed spend is reused. Default 30 seconds. */
  cacheMs?: number
}

/** Cost and run count of a scope's runs in a range, from `aggregate`. */
async function spendOf(
  usage: Pick<AiUsageStore, 'aggregate'>,
  range: { from: string; to: string },
  filter: { scope?: Scope; taskKind?: string },
): Promise<{ costUsd: number; runs: number }> {
  const [bucket] = await usage.aggregate({
    from: range.from,
    to: range.to,
    filter: {
      ...(filter.scope && { scopes: [filter.scope] }),
      ...(filter.taskKind !== undefined && { taskKind: filter.taskKind }),
    },
  })
  return { costUsd: bucket?.costUsd ?? 0, runs: (bucket?.runs ?? 0) - (bucket?.denied ?? 0) }
}

/**
 * Checks the weekly budgets from the `llm.budget` settings against recorded spend. Without a
 * valid global entry the default budget ($150 a week, $25 reserve, `block`) applies to
 * everything. A run exceeds a budget when this week's spend plus its estimate goes above the
 * budget's limit: `weeklyUsd - reserveUsd` for automatic work, `weeklyUsd` for interactive work.
 * A `warn` budget only reports; an exceeded `block` budget denies. Spend is cached for `cacheMs`
 * and bumped by `note`. The audit event is deduplicated in process memory, so a restart may
 * emit it once more in the same week.
 */
export function budgetGuard({
  settings,
  usage,
  audit,
  now = () => new Date(),
  timeZone = instanceTimeZone(),
  cacheMs = 30_000,
}: BudgetGuardOptions): BudgetGuard {
  const cache = new Map<
    string,
    {
      costUsd: number
      runs: number
      expires: number
      scope?: Scope
      taskKind?: string
      from: string
      to: string
    }
  >()
  const reported = new Set<string>()

  async function cached(
    range: PeriodRange,
    at: Date,
    filter: { scope?: Scope; taskKind?: string },
  ) {
    const id = JSON.stringify([filter.scope ?? null, filter.taskKind ?? null, range.key])
    const hit = cache.get(id)
    if (hit && hit.expires > at.getTime()) return hit
    const value = {
      ...(await spendOf(usage, range, filter)),
      expires: at.getTime() + cacheMs,
      ...filter,
      from: range.from,
      to: range.to,
    }
    cache.set(id, value)
    return value
  }

  return {
    async check({ repo, taskKind, interactive = false, estimateUsd }) {
      const at = now()
      const week = weekRange(at, timeZone)
      const budgets = applicableBudgets(
        withDefaultBudget(parseBudgets(await settings.list(budgetKey))),
        repo,
      )
      let estimate = estimateUsd
      if (estimate === undefined) {
        const history = await cached(week, at, { taskKind })
        estimate = history.runs > 0 ? history.costUsd / history.runs : 0
      }
      const exceeded: BudgetLimitStatus[] = []
      let remaining: number | undefined
      for (const scoped of budgets) {
        const { budget } = scoped
        const limitUsd = limitFor(budget, interactive)
        const { costUsd: spentUsd } = await cached(week, at, { scope: scoped.scope })
        if (budget.action === 'block')
          remaining = Math.min(remaining ?? Infinity, Math.max(limitUsd - spentUsd, 0))
        if (spentUsd + estimate <= limitUsd) continue
        const status: BudgetLimitStatus = {
          budgetId: scoped.id,
          scope: scoped.scope,
          action: budget.action,
          week: week.key,
          weeklyUsd: budget.weeklyUsd,
          reserveUsd: budget.reserveUsd,
          limitUsd,
          spentUsd,
          estimateUsd: estimate,
          interactive,
        }
        exceeded.push(status)
        const once = JSON.stringify([status.budgetId, week.key, interactive])
        if (audit && !reported.has(once)) {
          reported.add(once)
          await audit.append({
            at: at.toISOString(),
            actor: SYSTEM_ACTOR,
            via: 'system',
            action: 'ai.budget_exceeded',
            target: { type: 'budget', id: status.budgetId, repo: `${repo.forge}:${repo.path}` },
            outcome: status.action === 'block' ? 'denied' : 'ok',
            details: { ...status, taskKind },
          })
        }
      }
      return {
        allowed: !exceeded.some((s) => s.action === 'block'),
        exceeded,
        ...(remaining !== undefined && { remainingUsd: remaining }),
      }
    },
    note(record) {
      for (const entry of cache.values()) {
        if (record.at < entry.from || record.at >= entry.to) continue
        if (entry.taskKind !== undefined) {
          if (entry.taskKind !== record.taskKind) continue
          if (record.outcome !== 'denied-budget') entry.runs += 1
        }
        if (entry.scope && !scopeCoversRepo(entry.scope, { ...record.repo, groups: record.groups }))
          continue
        entry.costUsd += record.costUsd
      }
    },
  }
}

/** A budget with this week's spend, for display. */
export interface BudgetStatus {
  /** Setting entry id, or `DEFAULT_BUDGET_ID` for the implicit default. */
  id: string
  scope: Scope
  action: Budget['action']
  weeklyUsd: number
  reserveUsd: number
  spentUsd: number
  /** `spentUsd / weeklyUsd * 100`. */
  percent: number
  /** Linear projection of this week's spend to its end. */
  projectedUsd: number
  /** The current week, Monday 00:00 to Monday 00:00 in the instance time zone. */
  week: PeriodRange
}

/**
 * This week's state of every valid budget among `entries`, at `now`; the default budget stands in
 * for a missing global one when `includeDefault` is set.
 */
export async function budgetStatuses(
  entries: readonly SettingEntry[],
  usage: Pick<AiUsageStore, 'aggregate'>,
  now: Date,
  {
    timeZone = instanceTimeZone(),
    includeDefault = false,
  }: { timeZone?: string; includeDefault?: boolean } = {},
): Promise<BudgetStatus[]> {
  const week = weekRange(now, timeZone)
  const parsed = parseBudgets(entries)
  return Promise.all(
    (includeDefault ? withDefaultBudget(parsed) : parsed).map(async ({ id, scope, budget }) => {
      const { costUsd: spentUsd } = await spendOf(usage, week, { scope })
      return {
        id,
        scope,
        action: budget.action,
        weeklyUsd: budget.weeklyUsd,
        reserveUsd: budget.reserveUsd,
        spentUsd,
        percent: (spentUsd / budget.weeklyUsd) * 100,
        projectedUsd: projectPeriodEnd(spentUsd, week, now),
        week,
      }
    }),
  )
}
