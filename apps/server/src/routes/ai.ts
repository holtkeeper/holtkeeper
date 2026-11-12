import { type Principal, type Scope, can } from '@holtkeeper/access'
import { codeTools, docsTools, knowledgeTools, libraryTools } from '@holtkeeper/agent-tools'
import {
  type PeriodKind,
  type PeriodRange,
  broadestBudget,
  budgetKey,
  byCost,
  budgetStatuses,
  featureTaskKinds,
  filterableFeatures,
  isFilterableFeature,
  periodKinds,
  periodSpans,
  spendForecast,
  usageTotals,
  weekBreakdown,
  weekRange,
} from '@holtkeeper/ai-usage'
import type {
  AgentToolList,
  AgentToolView,
  AiBudgetOverview,
  AiRunList,
  AiSpendCaps,
  AiUsageBuckets,
  AiUsageOverview,
  AiUsagePeriod,
  AiWeekBreakdown,
} from '@holtkeeper/api'
import {
  type AiRunOrigin,
  type AiRunOutcome,
  type AiUsageDimension,
  type AiUsageFilter,
  aiUsageDimensions,
} from '@holtkeeper/store'
import {
  DEFAULT_TASK_BUDGET_USD,
  MAX_TASK_BUDGET_USD,
  WRITE_TASK_KIND,
} from '@holtkeeper/write-task'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { CHAT_REPLY_LIMITS } from '../chat-threads.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  limitParam,
  parseRepo,
  principalOf,
  repoTarget,
  ForbiddenException,
} from '../context.ts'
import { assetsToolset } from '../tools/assets.ts'
import { catalogToolset } from '../tools/catalog.ts'
import { opsToolset } from '../tools/ops.ts'
import { mcpToolsets, taskToolsets } from '../tools/registry.ts'
import { releasesToolset } from '../tools/releases.ts'
import { rulesToolset } from '../tools/rules.ts'
import { stackToolset } from '../tools/stack.ts'
import { peopleOf } from './avatars.ts'

const readActions = ['ai:read', 'ai:admin'] as const
const outcomes: readonly AiRunOutcome[] = ['ok', 'error', 'denied-budget']
const origins: readonly AiRunOrigin[] = ['interactive', 'automatic']
const top = 5
const dayMs = 86_400_000

/**
 * Scopes the principal may read AI usage in (`ai:read`, or `ai:admin` which includes it): `all`
 * for everything, an empty list for nothing.
 */
export function aiReadScopes(principal: Principal): Scope[] | 'all' {
  const scopes = principal.grants
    .filter((grant) =>
      grant.actions.some((action) => action === '*' || readActions.some((a) => a === action)),
    )
    .map((grant) => grant.scope)
  return scopes.some((scope) => scope.all) ? 'all' : scopes
}

/** As `aiReadScopes`, `undefined` for everything; 403 when there are none. */
function readableScopes(principal: Principal): Scope[] | undefined {
  const scopes = aiReadScopes(principal)
  if (scopes === 'all') return undefined
  if (!scopes.length) throw new ForbiddenException('ai:read')
  return scopes
}

/** Whether the principal may read the AI usage and budget of `scope`. */
export const canReadAiScope = (principal: Principal, scope: Scope) =>
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

/** `groups=a,b` as a list; `undefined` when absent or empty. */
function groupsParam(value: string | undefined): string[] | undefined {
  const groups = [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
  return groups.length ? groups : undefined
}

function periodParam(value: string | undefined): PeriodKind {
  if (!value) return 'week'
  const period = periodKinds.find((kind) => kind === value)
  if (!period)
    throw new HTTPException(400, { message: `period must be one of ${periodKinds.join(', ')}` })
  return period
}

/** `week=YYYY-MM-DD` (a Monday) as its budget week; the current week when absent. */
function weekParam(value: string | undefined, now: Date): PeriodRange {
  if (!value) return weekRange(now)
  const week = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? weekRange(new Date(`${value}T12:00:00.000Z`))
    : undefined
  if (week?.key !== value)
    throw new HTTPException(400, { message: 'week must be a Monday, YYYY-MM-DD' })
  return week
}

/** What the caller may read, narrowed to `groups=` when given; never wider than its scopes. */
const readsPeople = (principal: Principal) =>
  principal.grants.some(
    (grant) => grant.actions.includes('*') || grant.actions.includes('users:read'),
  )

function accessOf(c: AppContext): AiUsageFilter {
  const scopes = readableScopes(principalOf(c))
  const groups = groupsParam(c.req.query('groups'))
  return { ...(scopes && { scopes }), ...(groups && { groups }) }
}

/** The page filters every AI usage endpoint takes: `feature`, `origin`, `model` and `taskKind`. */
function narrowOf(c: AppContext): AiUsageFilter {
  const text = (name: string) => c.req.query(name) || undefined
  const origin = text('origin')
  if (origin !== undefined && !origins.some((o) => o === origin))
    throw new HTTPException(400, { message: `origin must be one of ${origins.join(', ')}` })
  const feature = text('feature')
  let taskKinds: string[] | undefined
  if (feature !== undefined) {
    if (!isFilterableFeature(feature))
      throw new HTTPException(400, {
        message: `feature must be one of ${filterableFeatures.join(', ')}`,
      })
    taskKinds = [...featureTaskKinds[feature]]
  }
  const model = text('model')
  const taskKind = text('taskKind')
  const started = origins.find((o) => o === origin)
  return {
    ...(started && { origin: started }),
    ...(taskKinds && { taskKinds }),
    ...(model !== undefined && { model }),
    ...(taskKind !== undefined && { taskKind }),
  }
}

/** Mean cost of a chat reply that ran between `from` and `to` within `access`. */
async function chatReplyAverage(
  usage: ServerDeps['store']['aiUsage'],
  access: AiUsageFilter,
  from: string,
  to: string,
): Promise<number | undefined> {
  const totals = await usageTotals(usage, { ...access, from, to, taskKind: 'chat' })
  const replies = totals.runs - totals.denied
  return replies > 0 ? totals.costUsd / replies : undefined
}

/** Task kinds whose mounted toolsets the registry names, in the order `usedBy` lists them. */
const registryTaskKinds = ['review', 'chat', WRITE_TASK_KIND]

/**
 * Stands in for every context a toolset factory takes: factories only close over it, so building
 * them with it yields the tool definitions without reaching anything. Never run these tools.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an inert stand-in for any context
const inert: never = new Proxy(() => {}, {
  get: (_target, key) => (key === 'then' ? undefined : inert),
  apply: () => inert,
}) as never

/** Every tool of the registry with the task kinds and MCP clients that get it. */
function agentToolRegistry(): AgentToolView[] {
  const internal = [
    codeTools(),
    docsTools(),
    knowledgeTools({ access: inert, repo: inert, taskKind: 'review', actor: 'registry' }),
    libraryTools({ access: inert, repo: 'registry:registry' }),
    catalogToolset(inert),
    stackToolset(inert),
    rulesToolset(inert),
    releasesToolset(inert),
    opsToolset(inert, () => new Date(0)),
    assetsToolset(inert),
  ].filter((toolset) => toolset !== undefined)
  const mounted = new Map(registryTaskKinds.map((kind) => [kind, new Set(taskToolsets(kind))]))
  const tools = new Map<string, AgentToolView>()
  const add = (
    toolset: string,
    tool: { name: string; description: string; readOnly?: boolean },
    by: string,
  ) => {
    const known = tools.get(tool.name)
    if (known) {
      if (!known.usedBy.includes(by)) known.usedBy.push(by)
      return
    }
    tools.set(tool.name, {
      name: tool.name,
      toolset,
      description: tool.description,
      readOnly: tool.readOnly ?? true,
      usedBy: [by],
    })
  }
  for (const toolset of internal)
    for (const kind of registryTaskKinds)
      if (mounted.get(kind)?.has(toolset.name))
        for (const tool of toolset.tools) add(toolset.name, tool, kind)
  for (const toolset of mcpToolsets(inert))
    for (const tool of toolset.tools) add(toolset.name, tool, 'mcp')
  return [...tools.values()].toSorted(
    (a, b) => a.toolset.localeCompare(b.toolset) || a.name.localeCompare(b.name),
  )
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
        throw new ForbiddenException('ai:read', c.req.query('repo'))
    }
    const text = (name: string) => c.req.query(name) || undefined
    const outcome = text('outcome')
    if (outcome !== undefined && !outcomes.some((o) => o === outcome))
      throw new HTTPException(400, { message: `unknown outcome ${outcome}` })
    const narrow = narrowOf(c)
    const groups = groupsParam(c.req.query('groups'))
    const from = timeParam(c, 'from')
    const to = timeParam(c, 'to')
    const fields = {
      from,
      to,
      group: text('group'),
      provider: text('provider'),
      analyzer: text('analyzer'),
      actor: text('actor'),
      outcome: outcomes.find((o) => o === outcome),
    }
    return {
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      ...narrow,
      ...(groups && { groups }),
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
      usageTotals(store.aiUsage, filter),
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
    const people = readsPeople(principalOf(c))
      ? await peopleOf(
          { store },
          page.flatMap((run) => (run.interactive ? [run.actor] : [])),
        )
      : undefined
    return c.json<AiRunList>({
      runs: page,
      ...(people && { people }),
      ...(runs.length > limit && last && { next: last.at }),
    })
  })

  app.get('/ai/overview', async (c) => {
    const principal = principalOf(c)
    const access = accessOf(c)
    const narrowed = { ...access, ...narrowOf(c) }
    const kind = periodParam(c.req.query('period'))
    const at = now()
    const spans = periodSpans(kind, at)
    const period = async (range: PeriodRange): Promise<AiUsagePeriod> => {
      const span = { from: range.from, to: range.to }
      const [totals, automatic] = await Promise.all([
        usageTotals(store.aiUsage, { ...narrowed, ...span }),
        narrowed.origin === 'interactive'
          ? undefined
          : usageTotals(store.aiUsage, { ...narrowed, ...span, origin: 'automatic' }),
      ])
      return { ...range, totals, automaticUsd: automatic?.costUsd ?? 0 }
    }
    const topBy = async (dimension: AiUsageDimension) =>
      byCost(
        await store.aiUsage.aggregate({
          from: spans.current.from,
          to: spans.current.to,
          groupBy: [dimension],
          filter: narrowed,
        }),
      ).slice(0, top)
    const entries = (await store.settings.list(budgetKey)).filter((entry) =>
      canReadAiScope(principal, entry.scope),
    )
    const [
      current,
      comparison,
      topRepos,
      topModels,
      topTaskKinds,
      topAnalyzers,
      budgets,
      forecast,
      chatReplyAvgUsd,
    ] = await Promise.all([
      period(spans.current),
      period(spans.comparison),
      topBy('repo'),
      topBy('model'),
      topBy('taskKind'),
      topBy('analyzer'),
      budgetStatuses(entries, store.aiUsage, at, {
        includeDefault: canReadAiScope(principal, { all: true }),
      }),
      spendForecast(store.aiUsage, at, { filter: narrowed, perDay: true }),
      chatReplyAverage(store.aiUsage, access, spans.current.from, spans.current.to),
    ])
    const { totals } = current
    const input = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
    const ran = totals.runs - totals.denied
    const stopsAt = broadestBudget(budgets)?.automaticStopsAt
    return c.json<AiUsageOverview>({
      period: kind,
      current,
      comparison,
      topRepos,
      topModels,
      topTaskKinds,
      topAnalyzers,
      budgets,
      cacheHitRatio: input ? totals.cacheReadTokens / input : 0,
      errorRate: ran ? totals.errors / ran : 0,
      ...(stopsAt !== undefined && { automaticStopsAt: stopsAt }),
      forecast,
      caps: {
        writeTaskUsd: DEFAULT_TASK_BUDGET_USD,
        writeTaskMaxUsd: MAX_TASK_BUDGET_USD,
        chatReplyUsd: CHAT_REPLY_LIMITS.maxCostUsd,
        ...(chatReplyAvgUsd !== undefined && { chatReplyAvgUsd }),
      } satisfies AiSpendCaps,
    })
  })

  app.get('/ai/budget', async (c) => {
    const principal = principalOf(c)
    const scopes = readableScopes(principal)
    const access: AiUsageFilter = scopes ? { scopes } : {}
    const at = now()
    const week = weekRange(at)
    const all = await store.settings.list(budgetKey)
    const entries = all.filter((entry) => canReadAiScope(principal, entry.scope))
    const [statuses, totals, buckets] = await Promise.all([
      budgetStatuses(entries, store.aiUsage, at, {
        includeDefault: canReadAiScope(principal, { all: true }),
      }),
      usageTotals(store.aiUsage, { ...access, from: week.from, to: week.to }),
      store.aiUsage.aggregate({
        from: week.from,
        to: week.to,
        groupBy: ['taskKind'],
        filter: access,
      }),
    ])
    const budget = broadestBudget(statuses)
    const global = entries.find((entry) => entry.scope.all === true)
    return c.json<AiBudgetOverview>({
      week,
      spentUsd: totals.costUsd,
      runs: totals.runs - totals.denied,
      ...(budget && { budget }),
      ...(global?.updatedBy !== undefined && {
        budgetChanged: { at: global.updatedAt, by: global.updatedBy },
      }),
      byFeature: buckets
        .filter((bucket) => bucket.costUsd > 0)
        .map((bucket) => ({
          feature: bucket.key.taskKind || 'other',
          costUsd: bucket.costUsd,
          runs: bucket.runs - bucket.denied,
        }))
        .toSorted((a, b) => b.costUsd - a.costUsd || a.feature.localeCompare(b.feature)),
      scopes: statuses
        .filter((status) => status.scope.all !== true && status.id !== 'default')
        .map((status) => ({
          settingId: status.id,
          scope: status.scope,
          weeklyUsd: status.weeklyUsd,
          reserveUsd: status.reserveUsd,
          action: status.action,
          warnPercent: status.warnPercent,
          spentUsd: status.spentUsd,
          percent: status.percent,
        }))
        .toSorted((a, b) => b.percent - a.percent || a.settingId.localeCompare(b.settingId)),
    })
  })

  let registry: AgentToolView[] | undefined
  app.get('/ai/tools', (c) => {
    readableScopes(principalOf(c))
    registry ??= agentToolRegistry()
    return c.json<AgentToolList>({ tools: registry })
  })

  app.get('/ai/week', async (c) => {
    const access = accessOf(c)
    const week = weekParam(c.req.query('week'), now())
    return c.json<AiWeekBreakdown>(await weekBreakdown(store.aiUsage, week, access))
  })

  return app
}
