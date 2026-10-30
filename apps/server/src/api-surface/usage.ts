import type { McpCallView, McpUsageOverview } from '@holtkeeper/api'
import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

const dayCountersSchema = z.object({
  calls: z.number(),
  errors: z.number(),
  tools: z.record(z.string(), z.object({ calls: z.number(), errors: z.number() })),
  people: z.record(z.string(), z.object({ name: z.string(), calls: z.number() })),
  packages: z.record(z.string(), z.number()),
  clients: z.record(z.string(), z.number()),
})

type DayCounters = z.infer<typeof dayCountersSchema>

const callsSchema = z.array(
  z.object({
    at: z.string(),
    tool: z.string(),
    principal: z.string(),
    client: z.string().optional(),
    subject: z.string().optional(),
    ok: z.boolean(),
    durationMs: z.number(),
  }),
)

const emptyDay = (): DayCounters => ({
  calls: 0,
  errors: 0,
  tools: {},
  people: {},
  packages: {},
  clients: {},
})

const dayOf = (value: unknown): DayCounters => {
  const parsed = dayCountersSchema.safeParse(value)
  return parsed.success ? parsed.data : emptyDay()
}

const callsOf = (value: unknown): McpCallView[] => {
  const parsed = callsSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

const dayKey = (date: string) => `mcp:usage:${date}`
const recentKey = 'mcp:recent'
const recentSize = 200

function addDay(into: DayCounters, add: DayCounters): DayCounters {
  const result = structuredClone(into)
  result.calls += add.calls
  result.errors += add.errors
  for (const [tool, counts] of Object.entries(add.tools)) {
    const current = (result.tools[tool] ??= { calls: 0, errors: 0 })
    current.calls += counts.calls
    current.errors += counts.errors
  }
  for (const [id, person] of Object.entries(add.people)) {
    const current = (result.people[id] ??= { name: person.name, calls: 0 })
    current.name = person.name
    current.calls += person.calls
  }
  for (const [name, calls] of Object.entries(add.packages))
    result.packages[name] = (result.packages[name] ?? 0) + calls
  for (const [client, calls] of Object.entries(add.clients))
    result.clients[client] = (result.clients[client] ?? 0) + calls
  return result
}

const dateOf = (at: string) => at.slice(0, 10)

const sorted = <T extends { calls: number }>(items: T[]) =>
  items.toSorted((a, b) => b.calls - a.calls)

/** One MCP tool call to count. */
export interface McpCall extends McpCallView {
  /** Display name of `principal`. */
  name: string
}

/** Options of `mcpUsage`. */
export interface McpUsageOptions {
  /** Where counters live; without it they last until the process exits. */
  kv?: KvStore
  now: () => Date
  /** Calls are written in batches at most this often. Default 5 s. */
  flushMs?: number
  /** Days the daily counters are kept. Default 120. */
  retentionDays?: number
}

/**
 * Counts MCP tool calls per day (by tool, person, package and client) and keeps the newest 200
 * calls. Calls are buffered and merged into `Store.kv` in batches, with `compareAndSet` where the
 * store has it; concurrent processes without it may lose a few counts, which is fine for usage
 * statistics.
 */
export function mcpUsage(options: McpUsageOptions) {
  const memory = new Map<string, unknown>()
  const kv: Pick<KvStore, 'get' | 'set' | 'compareAndSet'> = options.kv ?? {
    get: async (key) => memory.get(key),
    set: async (key, value) => {
      memory.set(key, value)
    },
  }
  const flushMs = options.flushMs ?? 5_000
  const ttl = (options.retentionDays ?? 120) * 86_400
  let days = new Map<string, DayCounters>()
  let recent: McpCallView[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing: Promise<void> | undefined

  const merge = async (key: string, update: (current: unknown) => unknown, seconds?: number) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- compare-and-set retries in order
      const current = await kv.get(key)
      const next = update(current)
      if (!kv.compareAndSet) return kv.set(key, next, seconds)
      // oxlint-disable-next-line no-await-in-loop -- see above
      if (await kv.compareAndSet(key, current, next, seconds)) return
    }
  }

  const flush = async () => {
    if (flushing) await flushing
    timer = undefined
    const batch = days
    const calls = recent
    days = new Map()
    recent = []
    if (!batch.size && !calls.length) return
    flushing = (async () => {
      for (const [date, counters] of batch)
        // oxlint-disable-next-line no-await-in-loop -- a day or two per batch
        await merge(dayKey(date), (current) => addDay(dayOf(current), counters), ttl)
      if (calls.length)
        await merge(recentKey, (current) => [...calls, ...callsOf(current)].slice(0, recentSize))
    })().finally(() => {
      flushing = undefined
    })
    await flushing
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => void flush().catch(() => {}), flushMs)
    timer.unref?.()
  }

  return {
    record(call: McpCall) {
      const date = dateOf(call.at)
      const day = days.get(date) ?? emptyDay()
      day.calls += 1
      if (!call.ok) day.errors += 1
      const tool = (day.tools[call.tool] ??= { calls: 0, errors: 0 })
      tool.calls += 1
      if (!call.ok) tool.errors += 1
      const person = (day.people[call.principal] ??= { name: call.name, calls: 0 })
      person.calls += 1
      if (call.subject) day.packages[call.subject] = (day.packages[call.subject] ?? 0) + 1
      if (call.client) day.clients[call.client] = (day.clients[call.client] ?? 0) + 1
      days.set(date, day)
      const { name: _, ...view } = call
      recent.unshift(view)
      if (recent.length > recentSize) recent.length = recentSize
      schedule()
    },

    /** Writes buffered calls now, e.g. before stopping or in tests. */
    flush,

    /**
     * Usage of the last `days` days. Without `everyone` the people list and recent calls are
     * limited to `self`.
     */
    async overview(input: {
      days: number
      self: string
      everyone: boolean
      endpoint: string
    }): Promise<McpUsageOverview> {
      await flush()
      const today = options.now()
      const dates = Array.from({ length: input.days }, (_, index) =>
        new Date(today.getTime() - (input.days - 1 - index) * 86_400_000)
          .toISOString()
          .slice(0, 10),
      )
      const counters = await Promise.all(
        dates.map(async (date) => {
          return dayOf(await kv.get(dayKey(date)))
        }),
      )
      const total = counters.reduce(addDay, emptyDay())
      const people = sorted(
        Object.entries(total.people).map(([id, person]) => ({
          id,
          name: person.name,
          calls: person.calls,
        })),
      )
      const calls = callsOf(await kv.get(recentKey))
      return {
        days: dates.map((date, index) => ({
          date,
          calls: counters[index]?.calls ?? 0,
          errors: counters[index]?.errors ?? 0,
        })),
        totals: { calls: total.calls, errors: total.errors, people: people.length },
        tools: sorted(Object.entries(total.tools).map(([tool, counts]) => ({ tool, ...counts }))),
        packages: sorted(
          Object.entries(total.packages).map(([name, n]) => ({ name, calls: n })),
        ).slice(0, 20),
        clients: sorted(Object.entries(total.clients).map(([client, n]) => ({ client, calls: n }))),
        people: input.everyone ? people : people.filter((person) => person.id === input.self),
        recent: (input.everyone
          ? calls
          : calls.filter((call) => call.principal === input.self)
        ).slice(0, 50),
        endpoint: input.endpoint,
      }
    },
  }
}

export type McpUsage = ReturnType<typeof mcpUsage>
