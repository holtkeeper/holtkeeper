import type {
  GitHubLimitView,
  GitHubRequestCounts,
  GitHubTokenUsage,
  GitHubTokenView,
} from '@holtkeeper/api'
import { type GitHubEvent, type GitHubTokenInfo, githubTokenInfo } from '@holtkeeper/libraries'
import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

/** Key of requests sent without a token. */
const ANONYMOUS = 'anonymous'

/** Key of waits, which belong to the pool rather than one token. */
const POOL = 'pool'

const countsSchema = z.object({
  requests: z.number(),
  notModified: z.number(),
  limited: z.number(),
  waits: z.number(),
  waitMs: z.number(),
})

/** One day: counts by token key (credential id or `anonymous`), then by resource. */
const daySchema = z.record(z.string(), z.record(z.string(), countsSchema))

type DayCounts = z.infer<typeof daySchema>

const emptyCounts = (): GitHubRequestCounts => ({
  requests: 0,
  notModified: 0,
  limited: 0,
  waits: 0,
  waitMs: 0,
})

const addCounts = (into: GitHubRequestCounts, add: GitHubRequestCounts) => {
  into.requests += add.requests
  into.notModified += add.notModified
  into.limited += add.limited
  into.waits += add.waits
  into.waitMs += add.waitMs
}

const dayOf = (value: unknown): DayCounts => daySchema.safeParse(value).data ?? {}

function mergeDays(into: DayCounts, add: DayCounts): DayCounts {
  const result = structuredClone(into)
  for (const [token, resources] of Object.entries(add))
    for (const [resource, counts] of Object.entries(resources))
      addCounts(((result[token] ??= {})[resource] ??= emptyCounts()), counts)
  return result
}

const dayKey = (date: string) => `github:usage:${date}`

/** Counts GitHub requests per day, token and resource; see `githubUsage`. */
export interface GitHubUsage {
  /** Counts one client event; `token` is a credential id, absent for anonymous requests. */
  record(event: GitHubEvent, token?: string): void
  /** Writes buffered counts now. */
  flush(): Promise<void>
  /** Stored days from `from` to `to` (`YYYY-MM-DD`, both included), oldest first, with the buffer. */
  days(from: string, to: string): Promise<{ day: string; counts: DayCounts }[]>
}

/** Options of `githubUsage`. */
export interface GitHubUsageOptions {
  /** Where counts live; without it they last until the process exits. */
  kv?: Pick<KvStore, 'get' | 'set' | 'compareAndSet'>
  now?: () => Date
  /** Counts are merged into `kv` at most this often. Default 5 s. */
  flushMs?: number
  /** Days the counts are kept. Default 90. */
  retentionDays?: number
}

/**
 * Counts GitHub requests by UTC day, token and resource: requests, `304`s from the `ETag` cache,
 * rate-limit answers and waits. Counts are buffered and merged into `Store.kv` in batches, with
 * `compareAndSet` where the store has it, so processes add up; a process that dies loses at most
 * one batch.
 */
export function githubUsage(options: GitHubUsageOptions = {}): GitHubUsage {
  const memory = new Map<string, unknown>()
  const kv: Pick<KvStore, 'get' | 'set' | 'compareAndSet'> = options.kv ?? {
    get: async (key) => memory.get(key),
    set: async (key, value) => {
      memory.set(key, value)
    },
  }
  const now = options.now ?? (() => new Date())
  const flushMs = options.flushMs ?? 5_000
  const ttl = (options.retentionDays ?? 90) * 86_400
  let buffer = new Map<string, DayCounts>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing: Promise<void> | undefined

  const merge = async (key: string, add: DayCounts) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a compare-and-set retry reads again
      const current = await kv.get(key)
      const next = mergeDays(dayOf(current), add)
      if (!kv.compareAndSet) return kv.set(key, next, ttl)
      // oxlint-disable-next-line no-await-in-loop -- see above
      if (await kv.compareAndSet(key, current, next, ttl)) return
    }
  }

  const flush = async () => {
    if (flushing) await flushing
    timer = undefined
    const batch = buffer
    buffer = new Map()
    if (!batch.size) return
    flushing = (async () => {
      for (const [date, counts] of batch)
        // oxlint-disable-next-line no-await-in-loop -- days are few and merged one by one
        await merge(dayKey(date), counts)
    })().finally(() => {
      flushing = undefined
    })
    await flushing
  }

  return {
    record(event, token) {
      const date = now().toISOString().slice(0, 10)
      const day = buffer.get(date) ?? {}
      buffer.set(date, day)
      const key = event.kind === 'wait' ? POOL : (token ?? ANONYMOUS)
      const counts = ((day[key] ??= {})[event.resource] ??= emptyCounts())
      if (event.kind === 'wait') {
        counts.waits += 1
        counts.waitMs += event.ms
      } else {
        counts.requests += 1
        if (event.notModified) counts.notModified += 1
        if (event.limited) counts.limited += 1
      }
      if (timer) return
      timer = setTimeout(() => void flush().catch(() => {}), flushMs)
      timer.unref?.()
    },
    flush,
    async days(from, to) {
      const result: { day: string; counts: DayCounts }[] = []
      for (
        let day = new Date(`${from}T00:00:00.000Z`);
        day.toISOString().slice(0, 10) <= to;
        day = new Date(day.getTime() + 86_400_000)
      ) {
        const date = day.toISOString().slice(0, 10)
        // oxlint-disable-next-line no-await-in-loop -- at most 90 small reads
        const stored = dayOf(await kv.get(dayKey(date)))
        result.push({ day: date, counts: mergeDays(stored, buffer.get(date) ?? {}) })
      }
      return result
    },
  }
}

const recorders = new WeakMap<object, GitHubUsage>()
let inMemory: GitHubUsage | undefined

/**
 * The process's `githubUsage` over `kv`, made on first use (with `now`, if given then); in memory
 * without one.
 */
export function githubUsageFor(
  kv: Pick<KvStore, 'get' | 'set' | 'compareAndSet'> | undefined,
  now?: () => Date,
) {
  if (!kv) return (inMemory ??= githubUsage(now ? { now } : {}))
  let found = recorders.get(kv)
  if (!found) recorders.set(kv, (found = githubUsage({ kv, ...(now ? { now } : {}) })))
  return found
}

/** A credential the `libraries.github` setting names, with its token when it could be read. */
export interface GitHubTokenCredential {
  id: string
  name: string
  token?: string
  error?: string
}

/** A credential list and a way to reveal one secret, e.g. the credential service. */
export interface GitHubCredentialSource {
  list(): Promise<readonly { id: string; name: string }[]>
  reveal(id: string): Promise<string>
}

/**
 * The credentials `references` name (id, else name), in order and once each, with their tokens.
 * A reference that matches nothing comes back with only `error`; one that cannot be revealed
 * with `error` and no `token`.
 */
export async function resolveGitHubTokens(
  credentials: GitHubCredentialSource,
  references: readonly string[],
): Promise<GitHubTokenCredential[]> {
  if (!references.length) return []
  const all = await credentials.list()
  const result: GitHubTokenCredential[] = []
  const seen = new Set<string>()
  for (const reference of references) {
    const credential =
      all.find((item) => item.id === reference) ?? all.find((item) => item.name === reference)
    if (!credential) {
      result.push({ id: reference, name: reference, error: `no credential "${reference}"` })
      continue
    }
    if (seen.has(credential.id)) continue
    seen.add(credential.id)
    try {
      // oxlint-disable-next-line no-await-in-loop -- a handful of credentials, read in order
      result.push({ ...credential, token: await credentials.reveal(credential.id) })
    } catch (error) {
      result.push({ ...credential, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/** Options of `githubTokenUsage`. */
export interface GitHubTokenUsageOptions {
  credentials: GitHubTokenCredential[]
  usage: GitHubUsage
  days: number
  now?: () => Date
  /** Default `githubTokenInfo`. */
  info?: (token: string | undefined) => Promise<GitHubTokenInfo>
}

/**
 * Use and limits of the GitHub tokens: live limits and accounts per token (tokens of an account
 * already listed are `duplicateOf` it and add nothing to `capacity`), counts per token over the
 * last `days` days, per day, and the pool's capacity.
 */
export async function githubTokenUsage(
  options: GitHubTokenUsageOptions,
): Promise<GitHubTokenUsage> {
  const now = options.now ?? (() => new Date())
  const info = options.info ?? githubTokenInfo
  await options.usage.flush()
  const to = now().toISOString().slice(0, 10)
  const from = new Date(now().getTime() - (options.days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const stored = await options.usage.days(from, to)

  const usageOf = (key: string) => {
    const resources: Record<string, GitHubRequestCounts> = {}
    for (const { counts } of stored)
      for (const [resource, add] of Object.entries(counts[key] ?? {}))
        addCounts((resources[resource] ??= emptyCounts()), add)
    return resources
  }

  const infos = await Promise.all(
    options.credentials.map((credential) =>
      credential.token ? info(credential.token) : Promise.resolve<GitHubTokenInfo>({}),
    ),
  )
  const owners = new Map<string, string>()
  const capacity: Record<string, GitHubLimitView> = {}
  const tokens: GitHubTokenView[] = options.credentials.map((credential, index) => {
    const found = infos[index] ?? {}
    const duplicateOf = found.login ? owners.get(found.login) : undefined
    if (found.login && !duplicateOf) owners.set(found.login, credential.id)
    if (!duplicateOf)
      for (const [resource, limit] of Object.entries(found.limits ?? {})) {
        const total = (capacity[resource] ??= {
          limit: 0,
          used: 0,
          remaining: 0,
          resetAt: limit.resetAt,
        })
        total.limit += limit.limit
        total.used += limit.used
        total.remaining += limit.remaining
        if (limit.resetAt < total.resetAt) total.resetAt = limit.resetAt
      }
    const error = credential.error ?? found.error
    return {
      credentialId: credential.id,
      name: credential.name,
      ...(found.login ? { login: found.login } : {}),
      ...(duplicateOf ? { duplicateOf } : {}),
      ...(found.limits ? { limits: found.limits } : {}),
      ...(error ? { error } : {}),
      usage: usageOf(credential.id),
    }
  })

  const totals = emptyCounts()
  const days = stored.map(({ day, counts }) => {
    const total = emptyCounts()
    const byToken: Record<string, number> = {}
    for (const [key, resources] of Object.entries(counts))
      for (const add of Object.values(resources)) {
        addCounts(total, add)
        if (key !== POOL) byToken[key] = (byToken[key] ?? 0) + add.requests
      }
    addCounts(totals, total)
    return { day, total, byToken }
  })

  return { tokens, anonymous: usageOf(ANONYMOUS), days, totals, capacity }
}
