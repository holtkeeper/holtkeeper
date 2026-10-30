import { type Principal, type Scope, can } from '@holtkeeper/access'
import { budgetKey, budgetStatuses, periodRange, previousMonth } from '@holtkeeper/ai-usage'
import type { AiRunList, AiUsageBuckets, AiUsageOverview, AiUsagePeriod } from '@holtkeeper/api'
import {
  type AiRunOutcome,
  type AiUsageDimension,
  type AiUsageFilter,
  type AiUsageStore,
  type AiUsageTotals,
  aiUsageDimensions,
  emptyAiUsageTotals,
} from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import {
  type AppContext,
  type Env,
  type ServerDeps,
  limitParam,
  parseRepo,
  principalOf,
  repoTarget,
} from '../context.ts'

const readActions = ['ai:read', 'ai:admin'] as const
const outcomes: readonly AiRunOutcome[] = ['ok', 'error', 'denied-budget']
const top = 5
const dayMs = 86_400_000

/**
 * Scopes the caller may read AI usage in (`ai:read`, or `ai:admin` which includes it), or
 * `undefined` when that is everything. 403 when there are none.
 */
function readableScopes(principal: Principal): Scope[] | undefined {
  const scopes = principal.grants
    .filter((grant) =>
      grant.actions.some((action) => action === '*' || readActions.some((a) => a === action)),
    )
    .map((grant) => grant.scope)
  if (!scopes.length) throw new HTTPException(403, { message: 'missing permission ai:read' })
  return scopes.some((scope) => scope.all) ? undefined : scopes
}

const canReadScope = (principal: Principal, scope: Scope) =>
  readActions.some((action) => can(principal, action, { kind: 'scope', scope }))

function timeParam(c: AppContext, name: string): string | undefined {
  const value = c.req.query(name)
  if (!value) return undefined
  const time = Date.parse(value)
  if (Number.isNaN(time)) throw new HTTPException(400, { message: `${name} must be a date` })
  return new Date(time).toISOString()
}

const isDimension = (item: string): item is AiUsageDimension =>
  aiUsageDimensions.some((dimension) => dimension === item)

function groupByParam(value: string | undefined): AiUsageDimension[] {
  if (!value) return []
  const items = value.split(',').map((item) => item.trim())
  const unknown = items.find((item) => !isDimension(item))
  if (unknown !== undefined) throw new HTTPException(400, { message: `unknown groupBy ${unknown}` })
  return [...new Set(items.filter(isDimension))]
}

const totalsOf = async (usage: AiUsageStore, filter: AiUsageFilter): Promise<AiUsageTotals> => {
  const [bucket] = await usage.aggregate({ filter })
  if (!bucket) return emptyAiUsageTotals()
  const { key: _key, ...totals } = bucket
  return totals
}

/**
 * AI usage history and budgets. Everything needs `ai:read`; rows are limited to repositories
 * (with the groups recorded on each run) the caller's `ai:read` grants cover, and asking for one
 * repository needs `ai:read` on it.
 */
export function aiRoutes({ store, config, now }: ServerDeps) {
  const app = new Hono<Env>()

  /** The caller's filter from the query string, access restriction included. */
  function filterOf(c: AppContext): AiUsageFilter {
    const principal = principalOf(c)
    const scopes = readableScopes(principal)
    const repo = parseRepo(c.req.query('repo'))
    if (repo) {
      const target = repoTarget(config, repo)
      if (!readActions.some((action) => can(principal, action, { kind: 'repo', repo: target })))
        throw new HTTPException(403, { message: 'missing permission ai:read' })
    }
    const text = (name: string) => c.req.query(name) || undefined
    const outcome = text('outcome')
    if (outcome !== undefined && !outcomes.some((o) => o === outcome))
      throw new HTTPException(400, { message: `unknown outcome ${outcome}` })
    const from = timeParam(c, 'from')
    const to = timeParam(c, 'to')
    const fields = {
      from,
      to,
      group: text('group'),
      model: text('model'),
      provider: text('provider'),
      taskKind: text('taskKind'),
      analyzer: text('analyzer'),
      outcome: outcomes.find((o) => o === outcome),
    }
    return {
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      ...(repo ? { repo } : scopes && { scopes }),
    }
  }

  app.get('/ai/usage', async (c) => {
    const filter = filterOf(c)
    if (filter.from === undefined)
      filter.from = new Date(now().getTime() - 30 * dayMs).toISOString()
    const groupBy = groupByParam(c.req.query('groupBy'))
    const [buckets, totals] = await Promise.all([
      store.aiUsage.aggregate({ groupBy, filter }),
      totalsOf(store.aiUsage, filter),
    ])
    return c.json<AiUsageBuckets>({
      from: filter.from,
      ...(filter.to !== undefined && { to: filter.to }),
      groupBy,
      buckets,
      totals,
    })
  })

  app.get('/ai/runs', async (c) => {
    const filter = filterOf(c)
    const before = timeParam(c, 'before')
    const limit = limitParam(c.req.query('limit'))
    const runs = await store.aiUsage.list({
      ...filter,
      ...(before !== undefined && { before }),
      limit: limit + 1,
    })
    const page = runs.slice(0, limit)
    const last = page.at(-1)
    return c.json<AiRunList>({
      runs: page,
      ...(runs.length > limit && last && { next: last.at }),
    })
  })

  app.get('/ai/overview', async (c) => {
    const principal = principalOf(c)
    const scopes = readableScopes(principal)
    const at = now()
    const access: AiUsageFilter = scopes ? { scopes } : {}
    const month = periodRange('month', at)
    const previous = previousMonth(at)
    const period = async (range: typeof month): Promise<AiUsagePeriod> => ({
      ...range,
      totals: await totalsOf(store.aiUsage, { ...access, from: range.from, to: range.to }),
    })
    const topBy = async (dimension: AiUsageDimension) =>
      (
        await store.aiUsage.aggregate({
          from: month.from,
          to: month.to,
          groupBy: [dimension],
          filter: access,
        })
      )
        .toSorted((a, b) => b.costUsd - a.costUsd || b.runs - a.runs)
        .slice(0, top)
    const entries = (await store.settings.list(budgetKey)).filter((entry) =>
      canReadScope(principal, entry.scope),
    )
    const [current, last, topRepos, topModels, topTaskKinds, budgets] = await Promise.all([
      period(month),
      period(previous),
      topBy('repo'),
      topBy('model'),
      topBy('taskKind'),
      budgetStatuses(entries, store.aiUsage, at),
    ])
    const { totals } = current
    const input = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
    const ran = totals.runs - totals.denied
    return c.json<AiUsageOverview>({
      month: current,
      previousMonth: last,
      topRepos,
      topModels,
      topTaskKinds,
      budgets,
      cacheHitRatio: input ? totals.cacheReadTokens / input : 0,
      errorRate: ran ? totals.errors / ran : 0,
    })
  })

  return app
}
