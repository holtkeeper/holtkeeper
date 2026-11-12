import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { type McpCall, mcpUsage } from './usage.ts'

const at = '2026-03-04T10:00:00.000Z'

const call = (tool: string, extra: Partial<McpCall> = {}): McpCall => ({
  at,
  tool,
  principal: 'u1',
  name: 'Ada',
  ok: true,
  durationMs: 5,
  ...extra,
})

const setup = () => {
  const kv = memoryStore().kv!
  const usage = mcpUsage({ kv, now: () => new Date(at) })
  const overview = (self = 'u1', everyone = false) =>
    usage.overview({ days: 3, self: { id: self, name: self }, everyone, endpoint: 'x' })
  return { kv, usage, overview }
}

describe('mcpUsage', () => {
  test('keeps calls, errors, last call, tools and tokens per person', async () => {
    const { usage, overview } = setup()
    usage.record(call('alpha', { token: 't1', subject: 'some-lib', client: 'cli' }))
    usage.record(
      call('alpha', {
        token: 't1',
        ok: false,
        at: '2026-03-04T11:00:00.000Z',
        subject: 'some-lib',
        client: 'cli',
      }),
    )
    usage.record(call('beta'))
    usage.record(call('beta', { principal: 'u2', name: 'Bo', token: 't2' }))
    const mine = await overview()
    expect(mine.me).toEqual({
      id: 'u1',
      name: 'Ada',
      calls: 3,
      errors: 1,
      lastAt: '2026-03-04T11:00:00.000Z',
      tools: [
        { tool: 'alpha', calls: 2 },
        { tool: 'beta', calls: 1 },
      ],
      packages: [{ name: 'some-lib', calls: 2 }],
      clients: [{ client: 'cli', calls: 2 }],
      daily: [0, 0, 3],
      dailyErrors: [0, 0, 1],
    })
    expect(mine.people.map((person) => person.id)).toEqual(['u1'])
    expect(mine.tokens).toEqual([{ id: 't1', calls: 2 }])
    expect((await overview('u3')).me).toMatchObject({ calls: 0, tools: [], daily: [0, 0, 0] })
    expect((await overview('u1', true)).people.map((person) => person.id)).toEqual(['u1', 'u2'])
  })

  test('keeps full per-person counts across batches and shows the top 10', async () => {
    const { usage, kv, overview } = setup()
    for (let n = 0; n < 30; n += 1)
      for (let k = 0; k <= n; k += 1) usage.record(call(`tool${n}`, { token: `t${n}` }))
    await usage.flush()
    for (let batch = 0; batch < 40; batch += 1) {
      usage.record(call('late', { token: 'tlate' }))
      // oxlint-disable-next-line no-await-in-loop -- one flush per batch
      await usage.flush()
    }
    const day = (await kv.get('mcp:usage:2026-03-04')) as {
      people: Record<string, { tools: object; tokens: object }>
    }
    expect(Object.keys(day.people.u1?.tools ?? {})).toHaveLength(31)
    expect(Object.keys(day.people.u1?.tokens ?? {})).toHaveLength(31)
    const me = (await overview()).me
    expect(me.calls).toBe(505)
    expect(me.tools).toHaveLength(10)
    expect(me.tools[0]).toEqual({ tool: 'late', calls: 40 })
    expect(me.tools.at(-1)).toEqual({ tool: 'tool21', calls: 22 })
  })
})
