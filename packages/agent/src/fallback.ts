import { BudgetExceededError, MaxTurnsError } from './errors.ts'
import { DEFAULT_TIER, type ModelTier, type ReasoningEffort } from './tiers.ts'
import type { TranscriptEntry, TranscriptSink } from './transcript.ts'
import type { Agent, AgentResult, AgentTask, AgentUsage } from './types.ts'

/** One model a tier may run on, and the agent that reaches it. */
export interface ModelRoute {
  /** Who serves the model, e.g. the credential name; reported as the run's `provider`. */
  provider: string
  /** The provider's model id; reported as the run's `model` when the agent reports none. */
  model: string
  /** Reasoning effort for tasks that ask for none; unset: the tier's. */
  effort?: ReasoningEffort
  /** Runs every task it gets on `model`, whatever tier the task asks for. */
  agent: Agent
}

/** The routes of each tier, most preferred first. */
export type TierRoutes = Readonly<Record<ModelTier, readonly ModelRoute[]>>

/** When each route last failed, by `routeKey`; share one between agents so they skip it alike. */
export type RouteHealth = Map<string, number>

/** An agent that runs each task on the first working route of its tier. */
export interface RoutedAgent extends Agent {
  /** The routes of `tier` (default `main`), most preferred first. */
  routesFor(tier?: ModelTier): readonly ModelRoute[]
}

export interface FallbackOptions {
  /** How long a failed route goes to the end of the line. Default five minutes. */
  cooldownMs?: number
  /** Shared failure times; default one of this agent's own. */
  health?: RouteHealth
  now?: () => number
  /** Told about every fallback. */
  log?: (line: string) => void
}

/** Default time a failed route waits behind the working ones. */
export const ROUTE_COOLDOWN_MS = 5 * 60_000

/** Identity of a route in `RouteHealth`. */
export const routeKey = (route: Pick<ModelRoute, 'provider' | 'model'>) =>
  `${route.provider}\u0000${route.model}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Errors of a route rather than of the task: unavailable, overloaded, refused or unreachable. */
const ROUTE_STATUSES = new Set([401, 402, 403, 404, 408, 409, 425, 429])

const ROUTE_CODES =
  /\b(model_not_found|invalid_model|provider_[a-z_]+|overloaded(?:_error)?|rate_limit(?:_error|_exceeded)?|service_unavailable|api_error|context_length_exceeded)\b/i

const ROUTE_TEXT =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|overloaded|API Error: (?:4(?:01|03|04|08|29)|5\d\d)|model (?:is )?not (?:found|available)/i

const ROUTE_ERROR_NAMES = new Set([
  'AI_NoSuchModelError',
  'AI_LoadAPIKeyError',
  'TimeoutError',
  'ConnectTimeoutError',
])

/** The status, code and text of `error` and the errors it wraps. */
function* errorChain(error: unknown) {
  const seen = new Set<unknown>()
  const queue: unknown[] = [error]
  while (queue.length) {
    const current = queue.shift()
    if (!isRecord(current) || seen.has(current)) continue
    seen.add(current)
    const status = current['statusCode'] ?? current['status']
    yield {
      name: typeof current['name'] === 'string' ? current['name'] : '',
      status: typeof status === 'number' ? status : undefined,
      text: [current['message'], current['responseBody'], current['code']]
        .filter((part): part is string => typeof part === 'string')
        .join(' '),
    }
    queue.push(current['lastError'], current['cause'])
    if (Array.isArray(current['errors'])) queue.push(...(current['errors'] as unknown[]))
  }
}

/**
 * Whether another model may run a task this error stopped: the route was unavailable (HTTP 404,
 * 408, 429, 5xx, a network failure or timeout, an unknown model), refused the key (401, 403) or
 * its balance (a `BudgetExceededError` the provider sent), or rejected the request in a way
 * another model may accept (a `provider_*` code, a too-long context). Never for a task cancelled
 * through its signal, a run that reached its turn limit or its own cost cap.
 */
export function routeFailed(error: unknown, task?: Pick<AgentTask, 'signal'>): boolean {
  if (task?.signal?.aborted) return false
  if (error instanceof MaxTurnsError) return false
  if (error instanceof BudgetExceededError)
    return error.httpStatus !== undefined || error.code !== undefined
  for (const { name, status, text } of errorChain(error)) {
    if (ROUTE_ERROR_NAMES.has(name)) return true
    if (status !== undefined && (status >= 500 || ROUTE_STATUSES.has(status))) return true
    if (ROUTE_CODES.test(text) || ROUTE_TEXT.test(text)) return true
  }
  return false
}

const changesCheckout = (task: AgentTask) =>
  task.capabilities?.some((capability) => capability === 'edit' || capability === 'run') ?? false

const addUsage = (sum: AgentUsage | undefined, usage: AgentUsage | undefined) =>
  !sum || !usage
    ? (usage ?? sum)
    : {
        inputTokens: sum.inputTokens + usage.inputTokens,
        outputTokens: sum.outputTokens + usage.outputTokens,
        cacheReadTokens: sum.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: sum.cacheWriteTokens + usage.cacheWriteTokens,
      }

/** Watches one attempt's transcript: whether it called tools and what its failed end reported. */
function attemptWatch(sink: TranscriptSink | undefined) {
  const state = { calledTools: false, usage: undefined as AgentUsage | undefined, costUsd: 0 }
  const watched: TranscriptSink = {
    write(entry: TranscriptEntry) {
      if (entry.type === 'assistant' && entry.toolCalls?.length) state.calledTools = true
      if (entry.type === 'end' && entry.outcome === 'error') {
        state.usage = entry.usage
        state.costUsd = entry.costUsd ?? 0
      }
      sink?.write(entry)
    },
  }
  return { state, sink: watched }
}

const reasonOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200)

/**
 * An agent that runs each task on its tier's routes in order (`task.tier`, default `main`) and
 * moves to the next route when one fails in a way another model may not (`routeFailed`). A failed
 * route is tried after the working ones for `cooldownMs`. A task that may edit the checkout or run
 * commands moves on only when the failed attempt called no tool, so no half-done change is
 * redone. The task's own `effort` wins over the route's. The result names the route that answered
 * (`provider`, `model`) and includes the usage and cost failed attempts reported. When no route
 * is left, the last error is thrown; a tier without routes throws at once.
 */
export function fallbackAgent(routes: TierRoutes, options: FallbackOptions = {}): RoutedAgent {
  const health = options.health ?? new Map<string, number>()
  const cooldownMs = options.cooldownMs ?? ROUTE_COOLDOWN_MS
  const now = options.now ?? Date.now
  const cooling = (route: ModelRoute) => {
    const failedAt = health.get(routeKey(route))
    return failedAt !== undefined && now() - failedAt < cooldownMs
  }
  const ordered = (tier: ModelTier) => {
    const all = routes[tier]
    return [...all.filter((route) => !cooling(route)), ...all.filter(cooling)]
  }

  return {
    name: 'routed',
    routesFor: (tier = DEFAULT_TIER) => routes[tier],
    async run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> {
      const tier = task.tier ?? DEFAULT_TIER
      const candidates = ordered(tier)
      if (!candidates.length) throw new Error(`no model is configured for tier ${tier}`)
      let usage: AgentUsage | undefined
      let costUsd = 0
      for (const [index, route] of candidates.entries()) {
        const watch = attemptWatch(task.transcript)
        const effort = task.effort ?? route.effort
        try {
          // oxlint-disable-next-line no-await-in-loop -- routes are tried one after another
          const result = await route.agent.run({
            ...task,
            tier,
            transcript: watch.sink,
            ...(effort && { effort }),
          })
          health.delete(routeKey(route))
          const total = addUsage(usage, result.usage)
          return {
            ...result,
            model: result.model ?? route.model,
            provider: route.provider,
            ...(total && { usage: total }),
            ...((result.costUsd !== undefined || costUsd > 0) && {
              costUsd: (result.costUsd ?? 0) + costUsd,
            }),
          }
        } catch (error) {
          usage = addUsage(usage, watch.state.usage)
          costUsd += watch.state.costUsd
          const next = candidates[index + 1]
          const movable = !changesCheckout(task) || !watch.state.calledTools
          if (!next || !movable || !routeFailed(error, task)) throw error
          health.set(routeKey(route), now())
          options.log?.(
            `${route.provider} ${route.model} failed (${reasonOf(error)}); ${task.taskKind ?? 'the task'} moves to ${next.provider} ${next.model}`,
          )
        }
      }
      throw new Error('unreachable')
    },
  }
}
