import { describe, expect, test } from 'bun:test'

import { BudgetExceededError, MaxTurnsError } from './errors.ts'
import { type ModelRoute, type TierRoutes, fallbackAgent, routeFailed } from './fallback.ts'
import type { TranscriptEntry } from './transcript.ts'
import type { Agent, AgentTask } from './types.ts'

const httpError = (statusCode: number, responseBody = '') =>
  Object.assign(new Error(`HTTP ${statusCode}`), {
    name: 'AI_APICallError',
    statusCode,
    responseBody,
  })

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

const task = (extra: Partial<AgentTask> = {}): AgentTask => ({
  dir: '/tmp/x',
  prompt: 'Review the widget',
  ...extra,
})

/** An agent that answers, or throws `fail`, and remembers the tasks it got. */
function fakeAgent(fail?: unknown, entries: TranscriptEntry[] = []) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    async run(given) {
      tasks.push(given)
      for (const entry of entries) given.transcript?.write(entry)
      if (fail !== undefined) throw fail
      return { text: 'done', turns: 2, costUsd: 0.5 }
    },
  }
  return { agent, tasks }
}

const route = (model: string, agent: Agent, extra: Partial<ModelRoute> = {}): ModelRoute => ({
  provider: 'Gateway',
  model,
  agent,
  ...extra,
})

const tiers = (main: ModelRoute[]): TierRoutes => ({ fast: [], main, deep: [] })

describe('routeFailed', () => {
  test('unavailable, overloaded and refused routes fail over', () => {
    for (const status of [401, 404, 429, 500, 503, 529])
      expect(routeFailed(httpError(status))).toBe(true)
    expect(routeFailed(new TypeError('fetch failed'))).toBe(true)
    expect(routeFailed(Object.assign(new Error('retries'), { lastError: httpError(502) }))).toBe(
      true,
    )
    expect(routeFailed(httpError(400, '{"error":{"code":"provider_bad_request"}}'))).toBe(true)
    expect(routeFailed(new BudgetExceededError('no funds', { httpStatus: 402 }))).toBe(true)
  })

  test('task errors, own caps and cancellations stay', () => {
    expect(routeFailed(httpError(400, '{"error":{"code":"validation_error"}}'))).toBe(false)
    expect(routeFailed(new BudgetExceededError('cap reached'))).toBe(false)
    expect(
      routeFailed(
        new MaxTurnsError('turns', {
          turns: 3,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      ),
    ).toBe(false)
    expect(routeFailed(new Error('the answer did not match the schema'))).toBe(false)
    const controller = new AbortController()
    controller.abort()
    expect(routeFailed(httpError(503), { signal: controller.signal })).toBe(false)
  })
})

describe('fallbackAgent', () => {
  test('runs on the first route and names it', async () => {
    const first = fakeAgent()
    const second = fakeAgent()
    const agent = fallbackAgent(
      tiers([route('model-a', first.agent, { effort: 'low' }), route('model-b', second.agent)]),
    )
    const result = await agent.run(task())
    expect(result).toMatchObject({ text: 'done', model: 'model-a', provider: 'Gateway' })
    expect(first.tasks[0]?.effort).toBe('low')
    expect(first.tasks[0]?.tier).toBe('main')
    expect(second.tasks).toHaveLength(0)
  })

  test('a task effort wins over the route effort', async () => {
    const first = fakeAgent()
    await fallbackAgent(tiers([route('model-a', first.agent, { effort: 'low' })])).run(
      task({ effort: 'high' }),
    )
    expect(first.tasks[0]?.effort).toBe('high')
  })

  test('moves to the next route when one is unavailable, adds its cost and cools it down', async () => {
    const lines: string[] = []
    let clock = 0
    const failing = fakeAgent(httpError(503), [
      {
        type: 'end',
        outcome: 'error',
        usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.25,
      },
    ])
    const working = fakeAgent()
    const agent = fallbackAgent(
      tiers([route('model-a', failing.agent), route('model-b', working.agent)]),
      { log: (line) => lines.push(line), now: () => clock, cooldownMs: 1000 },
    )
    const result = await agent.run(task({ taskKind: 'review' }))
    expect(result).toMatchObject({ model: 'model-b', costUsd: 0.75 })
    expect(result.usage?.inputTokens).toBe(10)
    expect(lines[0]).toContain('Gateway model-a failed (HTTP 503); review moves to Gateway model-b')

    await agent.run(task())
    expect(failing.tasks).toHaveLength(1)
    clock = 1000
    await agent.run(task()).catch(() => undefined)
    expect(failing.tasks).toHaveLength(2)
  })

  test('throws a task error without trying other routes', async () => {
    const failing = fakeAgent(httpError(400, 'validation_error'))
    const other = fakeAgent()
    const agent = fallbackAgent(
      tiers([route('model-a', failing.agent), route('model-b', other.agent)]),
    )
    expect(await failure(agent.run(task()))).toContain('HTTP 400')
    expect(other.tasks).toHaveLength(0)
  })

  test('throws the last error when every route fails', async () => {
    const agent = fallbackAgent(
      tiers([
        route('model-a', fakeAgent(httpError(503)).agent),
        route('model-b', fakeAgent(httpError(429)).agent),
      ]),
    )
    expect(await failure(agent.run(task()))).toContain('HTTP 429')
  })

  test('a task that changed the checkout does not start over elsewhere', async () => {
    const failing = fakeAgent(httpError(503), [
      { type: 'assistant', toolCalls: [{ id: '1', name: 'write_file', input: {} }] },
    ])
    const other = fakeAgent()
    const agent = fallbackAgent(
      tiers([route('model-a', failing.agent), route('model-b', other.agent)]),
    )
    expect(await failure(agent.run(task({ capabilities: ['read', 'edit'] })))).toContain('HTTP 503')
    expect(other.tasks).toHaveLength(0)
    await agent.run(task())
    expect(other.tasks).toHaveLength(1)
  })

  test('a tier without routes fails at once', async () => {
    expect(await failure(fallbackAgent(tiers([])).run(task({ tier: 'main' })))).toContain(
      'no model is configured for tier main',
    )
  })
})
