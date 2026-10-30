import { describe, expect, test } from 'bun:test'

import type { Agent, AgentResult, AgentTask } from '@holtkeeper/agent'

import { estimatePromptTokens, limitAgent } from './agent.ts'
import { createManualClock, settle } from './clock.ts'
import { limitFetch } from './fetch.ts'
import { limitJobs } from './jobs.ts'
import { LimitExceededError, createLimiter } from './limiter.ts'
import { failure } from './test-helpers.ts'

const setup = () => {
  const clock = createManualClock()
  return { clock, limiter: createLimiter({ clock }) }
}

describe('limitFetch', () => {
  test('a 429 cools down every caller of the token and is retried after it', async () => {
    const { clock, limiter } = setup()
    const calls: [string, number][] = []
    let limited = true
    const fake = async (url: string) => {
      calls.push([url, clock.now()])
      if (url === '/a' && limited) {
        limited = false
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } })
      }
      return new Response('ok')
    }
    const fetch = limitFetch(
      fake,
      limiter,
      'gitlab',
      { maxConcurrent: 8 },
      { now: () => clock.now() },
    )

    const a = fetch('/a')
    await settle()
    const b = fetch('/b')
    await clock.advance(1999)
    expect(calls.map(([url]) => url)).toEqual(['/a'])
    await clock.advance(1)
    expect((await a).status).toBe(200)
    expect((await b).status).toBe(200)
    const start = Date.parse('2026-10-30T10:00:00.000Z')
    expect(calls).toEqual([
      ['/a', start],
      ['/a', start + 2000],
      ['/b', start + 2000],
    ])
    expect((await limiter.snapshot()).gitlab).toMatchObject({
      inFlight: 0,
      last429At: '2026-10-30T10:00:00.000Z',
    })
  })

  test('returns the last 429 once retries are used up', async () => {
    const { clock, limiter } = setup()
    let calls = 0
    const fetch = limitFetch(
      async () => {
        calls++
        return new Response('', { status: 429 })
      },
      limiter,
      'gitlab',
      { backoff: { onStatus: [429], baseMs: 100, maxMs: 1000 } },
      { retries: 2, now: () => clock.now() },
    )
    const response = fetch('/x')
    await clock.advance(10_000)
    expect((await response).status).toBe(429)
    expect(calls).toBe(3)
  })

  test('respects the request rate and aborts while waiting', async () => {
    const { clock, limiter } = setup()
    const fetch = limitFetch(async () => new Response('ok'), limiter, 'gitlab', {
      requestsPerMinute: 60,
      burst: 1,
    })
    expect((await fetch('/1')).ok).toBe(true)
    const controller = new AbortController()
    const waiting = fetch('/2', { signal: controller.signal })
    await settle()
    controller.abort(new Error('canceled'))
    expect(await failure(waiting)).toHaveProperty('message', 'canceled')
    const later = fetch('/3')
    await clock.advance(1000)
    expect((await later).ok).toBe(true)
  })

  test('releases the slot when fetch throws', async () => {
    const { limiter } = setup()
    const fetch = limitFetch(async () => Promise.reject(new Error('network')), limiter, 'gitlab', {
      maxConcurrent: 1,
    })
    expect(await failure(fetch('/a'))).toHaveProperty('message', 'network')
    expect(await failure(fetch('/b'))).toHaveProperty('message', 'network')
    expect((await limiter.snapshot()).gitlab?.inFlight).toBe(0)
  })
})

const result = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  text: 'done',
  turns: 1,
  ...overrides,
})

const fakeAgent = (run: (task: AgentTask) => Promise<AgentResult>): Agent => ({
  name: 'fake',
  run: run as Agent['run'],
})

const task = (chars: number): AgentTask => ({ dir: '/tmp/x', prompt: 'x'.repeat(chars) })

describe('limitAgent', () => {
  test('estimates tokens from the prompt and corrects them from usage', async () => {
    const { limiter } = setup()
    const seen: number[] = []
    const agent = limitAgent(
      fakeAgent(async () => {
        seen.push((await limiter.snapshot()).ai?.tokensLeft ?? -1)
        return result({
          usage: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 999, cacheWriteTokens: 20 },
          costUsd: 0.25,
        })
      }),
      limiter,
      'ai',
      { tokensPerMinute: 10_000, maxConcurrent: 3 },
    )
    expect(estimatePromptTokens({ ...task(4000), system: 'abcd', context: 'efgh' })).toBe(1002)
    await agent.run(task(4000))
    expect(seen).toEqual([9000])
    expect((await limiter.snapshot()).ai).toMatchObject({
      tokensLeft: 9900,
      dayTokens: 100,
      dayCostUsd: 0.25,
      inFlight: 0,
    })
  })

  test('a run that would exceed tokensPerMinute waits for the bucket', async () => {
    const { clock, limiter } = setup()
    const started: number[] = []
    const agent = limitAgent(
      fakeAgent(async () => {
        started.push(clock.now())
        return result()
      }),
      limiter,
      'ai',
      { tokensPerMinute: 6000 },
    )
    await agent.run(task(24_000))
    const second = agent.run(task(8000))
    await clock.advance(19_999)
    expect(started).toHaveLength(1)
    await clock.advance(1)
    await second
    expect(started[1]).toBe((started[0] ?? 0) + 20_000)
  })

  test('daily caps deny runs before they start', async () => {
    const { limiter } = setup()
    let runs = 0
    const agent = limitAgent(
      fakeAgent(async () => {
        runs++
        return result({ costUsd: 3 })
      }),
      limiter,
      'ai',
      { costPerDayUsd: 2 },
    )
    await agent.run(task(10))
    expect(await failure(agent.run(task(10)))).toBeInstanceOf(LimitExceededError)
    expect(runs).toBe(1)
  })

  test('a rate-limit error starts the shared cool-down and is rethrown', async () => {
    const { limiter } = setup()
    const rateLimited = Object.assign(new Error('429 rate_limit_error'), {
      status: 429,
      headers: { 'retry-after': '30' },
    })
    const agent = limitAgent(
      fakeAgent(async () => Promise.reject(rateLimited)),
      limiter,
      'ai',
      { maxConcurrent: 3 },
    )
    expect(await failure(agent.run(task(10)))).toBe(rateLimited)
    expect((await limiter.snapshot()).ai).toMatchObject({
      inFlight: 0,
      coolDownUntil: '2026-10-30T10:00:30.000Z',
    })
  })

  test('one run holds one slot', async () => {
    const { limiter } = setup()
    const release: (() => void)[] = []
    const agent = limitAgent(
      fakeAgent(
        () =>
          new Promise((resolve) => {
            release.push(() => resolve(result()))
          }),
      ),
      limiter,
      'ai',
      { maxConcurrent: 2 },
    )
    const runs = [agent.run(task(1)), agent.run(task(1)), agent.run(task(1))]
    await settle()
    expect(release).toHaveLength(2)
    release[0]?.()
    await settle()
    expect(release).toHaveLength(3)
    for (const done of release.slice(1)) done()
    await Promise.all(runs)
  })
})

describe('limitJobs', () => {
  test('refuses jobs whose credentials are saturated', async () => {
    const { limiter } = setup()
    limiter.configure('ai', { maxConcurrent: 1 })
    const canClaim = limitJobs({
      limiter,
      keysFor: (job: { kind: string }) => (job.kind === 'review' ? ['gitlab', 'ai'] : ['gitlab']),
    })
    expect(await canClaim({ kind: 'review' })).toBe(true)
    const lease = await limiter.acquire('ai')
    expect(await canClaim({ kind: 'review' })).toBe(false)
    expect(await canClaim({ kind: 'depgraph' })).toBe(true)
    await lease.release()
    expect(await canClaim({ kind: 'review' })).toBe(true)
    await limiter.throttle('gitlab', { delayMs: 1000 })
    expect(await canClaim({ kind: 'depgraph' })).toBe(false)
  })
})
