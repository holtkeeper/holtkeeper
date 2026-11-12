import { type Scope, can } from '@holtkeeper/access'
import type { LimitUsageList, LimitUsagePolicy, LimitUsageRow } from '@holtkeeper/api'
import { type KeySnapshot, type LimitPolicy, resolveLimitPolicy } from '@holtkeeper/limits'
import { Hono } from 'hono'

import { type Env, type ServerDeps, authorize, principalOf } from '../context.ts'
import { globalLimits } from '../limits.ts'

const GLOBAL = { kind: 'global' } as const
const CACHE_MS = 5_000
const FORGE_PREFIX = 'forge:'

const policyView = (policy: LimitPolicy): LimitUsagePolicy => ({
  ...(policy.maxConcurrent !== undefined && { maxConcurrent: policy.maxConcurrent }),
  ...(policy.requestsPerMinute !== undefined && { requestsPerMinute: policy.requestsPerMinute }),
  ...(policy.burst !== undefined && { burst: policy.burst }),
  ...(policy.tokensPerMinute !== undefined && { tokensPerMinute: policy.tokensPerMinute }),
  ...(policy.tokensPerDay !== undefined && { tokensPerDay: policy.tokensPerDay }),
  ...(policy.costPerDayUsd !== undefined && { costPerDayUsd: policy.costPerDayUsd }),
})

const usageOf = (snapshot: KeySnapshot | undefined) => ({
  requestsLastHour: snapshot?.requestsLastHour ?? 0,
  tokensLastHour: snapshot?.tokensLastHour ?? 0,
  inFlight: snapshot?.inFlight ?? 0,
  ...(snapshot?.coolDownUntil !== undefined && { coolDownUntil: snapshot.coolDownUntil }),
  ...(snapshot?.last429At !== undefined && { last429At: snapshot.last429At }),
  dayTokens: snapshot?.dayTokens ?? 0,
  dayCostUsd: snapshot?.dayCostUsd ?? 0,
})

const used = (snapshot: KeySnapshot | undefined) =>
  snapshot !== undefined &&
  (snapshot.inFlight > 0 ||
    snapshot.requestsLastHour > 0 ||
    snapshot.tokensLastHour > 0 ||
    snapshot.dayTokens > 0 ||
    snapshot.last429At !== undefined)

/**
 * Live usage of every credential that has a limit, a `limits.credentials` entry or recorded use,
 * plus `forge:<id>` keys of forges without a credential and configured keys that name nothing.
 * Policies are resolved from the settings and configured on the limiter before its snapshot, so
 * a process that did none of the work still reports them correctly.
 */
async function limitUsage(
  deps: Pick<ServerDeps, 'credentials' | 'store' | 'limiter' | 'config' | 'configSource' | 'now'>,
): Promise<{ list: LimitUsageList; scopes: Map<string, Scope> }> {
  const [views, entries] = await Promise.all([
    deps.credentials.list(),
    deps.store.settings.list('limits.credentials'),
  ])
  const configured = globalLimits(entries) ?? {}
  const resolved = views.map((view) => ({
    view,
    policy: resolveLimitPolicy(view, configured),
    set: configured[view.id] !== undefined || configured[view.name] !== undefined,
  }))
  for (const { view, policy } of resolved) deps.limiter?.configure(view.id, policy)
  const snapshot = deps.limiter ? await deps.limiter.snapshot() : {}

  const rows: LimitUsageRow[] = []
  for (const { view, policy, set } of resolved) {
    const shown = policyView(policy)
    if (!set && Object.keys(shown).length === 0 && !used(snapshot[view.id])) continue
    rows.push({
      key: view.id,
      credentialId: view.id,
      name: view.name,
      kind: view.kind,
      policy: shown,
      source: set ? 'configured' : 'default',
      ...usageOf(snapshot[view.id]),
    })
  }

  const named = new Set(views.flatMap((view) => [view.id, view.name]))
  const forges = deps.configSource?.effective().forges ?? deps.config.forges
  const others = new Set([...Object.keys(snapshot), ...Object.keys(configured)])
  for (const key of others) {
    if (named.has(key)) continue
    const entry = configured[key]
    const forge = key.startsWith(FORGE_PREFIX) ? forges[key.slice(FORGE_PREFIX.length)] : undefined
    if (forge) {
      rows.push({
        key,
        name: `Forge ${key.slice(FORGE_PREFIX.length)}`,
        kind: forge.kind,
        policy: policyView(entry ?? deps.limiter?.policy(key) ?? {}),
        source: entry ? 'configured' : 'default',
        ...usageOf(snapshot[key]),
      })
    } else if (entry) {
      rows.push({
        key,
        name: key,
        missing: true,
        policy: policyView(entry),
        source: 'configured',
        ...usageOf(snapshot[key]),
      })
    }
  }

  return {
    list: {
      rows: rows.toSorted(
        (a, b) =>
          Number(a.missing ?? false) - Number(b.missing ?? false) || a.name.localeCompare(b.name),
      ),
      shared: deps.config.limits?.distributed === true,
      readAt: deps.now().toISOString(),
    },
    scopes: new Map(views.map((view) => [view.id, view.scope])),
  }
}

/**
 * `GET /limits/usage`: request-limit usage (`limitUsage`), for a global `settings:read`. Credential
 * rows follow `credentials:read`: a caller sees only credentials whose scope it may read, while
 * forge and unnamed configured keys show to everyone allowed in. The unfiltered answer is cached
 * for 5 seconds per process and filtered for each caller.
 */
export function limitRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  let cached:
    | { at: number; value: Promise<{ list: LimitUsageList; scopes: Map<string, Scope> }> }
    | undefined

  app.get('/limits/usage', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const now = deps.now().getTime()
    if (!cached || now - cached.at >= CACHE_MS || now < cached.at) {
      const value = limitUsage(deps)
      cached = { at: now, value }
      value.catch(() => {
        if (cached?.value === value) cached = undefined
      })
    }
    const { list, scopes } = await cached.value
    const principal = principalOf(c)
    const visible = (row: LimitUsageRow) => {
      const scope = row.credentialId === undefined ? undefined : scopes.get(row.credentialId)
      return (
        row.credentialId === undefined ||
        (scope !== undefined && can(principal, 'credentials:read', { kind: 'scope', scope }))
      )
    }
    return c.json<LimitUsageList>({ ...list, rows: list.rows.filter(visible) })
  })

  return app
}
