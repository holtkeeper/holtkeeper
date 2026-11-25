import { randomUUID } from 'node:crypto'

import type { Store } from '@holtkeeper/store'
import { z } from 'zod'

/** How long a comparison thread is remembered after its last change. */
const THREAD_TTL_SECONDS = 30 * 24 * 60 * 60

/** How long a handled Slack message (by channel and ts) is remembered. */
const MESSAGE_MEMORY_SECONDS = 60 * 60

const CAS_ATTEMPTS = 8

const repoSchema = z.object({ forge: z.string(), path: z.string() })

/** What a person asked to compare, as the parser understood it. */
const compareRequestSchema = z.object({
  /** `forge:path` of each repository, in the order they were named. */
  repos: z.array(z.string()),
  /** Names as written that match no known repository. */
  unresolved: z.array(z.string()).default([]),
  /** The environment the comparison starts from, as written. */
  from: z.string().optional(),
  /** The environment it compares against, as written. */
  to: z.string().optional(),
  /** What to look at; empty means everything. */
  focus: z.array(z.enum(['changes', 'tasks', 'dependencies', 'breaking'])).default([]),
  /** The language the person wrote in, for AI prose. */
  language: z.string().optional(),
})

export type CompareRequest = z.infer<typeof compareRequestSchema>

const sideSchema = z.object({
  environment: z.string(),
  tag: z.string().optional(),
  version: z.string().optional(),
  status: z.string().optional(),
})

/** One repository of the preview: the version on each side, or why it cannot be compared. */
const previewRowSchema = z.object({
  repo: repoSchema,
  webUrl: z.string().optional(),
  from: sideSchema.optional(),
  to: sideSchema.optional(),
  /** Older and newer tag once both sides are known and differ; `from` older unless `reversed`. */
  range: z.object({ from: z.string(), to: z.string(), reversed: z.boolean() }).optional(),
  problem: z.string().optional(),
})

export type PreviewRow = z.infer<typeof previewRowSchema>

const comparisonSchema = z.object({
  repo: repoSchema,
  from: z.string(),
  to: z.string(),
  commitCount: z.number(),
  capped: z.boolean(),
  entries: z.array(
    z.object({
      section: z.string(),
      text: z.string(),
      breaking: z.boolean(),
      mergeRequests: z.array(z.number()),
    }),
  ),
  tasks: z.array(
    z.object({
      key: z.string(),
      title: z.string().optional(),
      status: z.string().optional(),
      url: z.string().optional(),
    }),
  ),
  dependencies: z
    .array(
      z.object({
        name: z.string(),
        change: z.enum(['added', 'removed', 'upgraded', 'downgraded', 'changed']),
        from: z.string().optional(),
        to: z.string().optional(),
        major: z.boolean().optional(),
      }),
    )
    .optional(),
  summary: z.string().optional(),
  breaking: z
    .object({ status: z.enum(['done', 'running', 'unavailable']), items: z.array(z.string()) })
    .optional(),
  reportUrl: z.string().optional(),
  compareUrl: z.string().optional(),
})

/** The outcome of one repository's comparison as kept with the thread. */
const repoResultSchema = z.object({
  repo: repoSchema,
  comparison: comparisonSchema.optional(),
  error: z.string().optional(),
})

export type RepoResult = z.infer<typeof repoResultSchema>

const turnSchema = z.object({ role: z.enum(['person', 'bot']), text: z.string() })

/**
 * A comparison conversation in one Slack thread: `pending` waits for a confirmation, `running`
 * compares (run `runId` since `runningSince`), `done` answers follow-up questions, `cancelled`
 * and `failed` take a new request in the same thread.
 */
const compareThreadSchema = z.object({
  channel: z.string(),
  threadTs: z.string(),
  /** Slack user who asked first. */
  requestedBy: z.string(),
  status: z.enum(['pending', 'running', 'done', 'cancelled', 'failed']),
  request: compareRequestSchema,
  preview: z.array(previewRowSchema),
  /** The bot's preview message, edited when the request changes. */
  previewTs: z.string().optional(),
  runId: z.string().optional(),
  runningSince: z.string().optional(),
  results: z.array(repoResultSchema).optional(),
  summary: z.string().optional(),
  /** Follow-up questions and answers, newest last, a few kept. */
  turns: z.array(turnSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type CompareThread = z.infer<typeof compareThreadSchema>

const parse = (raw: unknown) => compareThreadSchema.safeParse(raw).data

const threadKey = (channel: string, threadTs: string) =>
  `slack:compare:thread:${channel}:${threadTs}`

/**
 * Comparison threads kept in `store.kv`, one document per thread. Changes go through
 * `compareAndSet` where the store has it, so two processes never both start a run.
 */
export interface CompareThreads {
  get(channel: string, threadTs: string): Promise<CompareThread | undefined>
  /**
   * Applies `change` to the current thread (`undefined` when there is none) and writes the result,
   * rereading on conflict. `change` returning `undefined` writes nothing. Resolves with what was
   * written, or `undefined`.
   */
  update(
    channel: string,
    threadTs: string,
    change: (current: CompareThread | undefined) => CompareThread | undefined,
  ): Promise<CompareThread | undefined>
  /**
   * `true` the first time a Slack message (channel and ts) is claimed within an hour across
   * processes sharing the store, so Slack's retries and a message seen twice are handled once.
   */
  claimMessage(channel: string, ts: string): Promise<boolean>
}

/** Comparison threads over `store.kv`, with an in-process fallback when the store has none. */
export function compareThreads(store: Pick<Store, 'kv'>, now: () => Date): CompareThreads {
  const local = new Map<string, unknown>()
  const claimed = new Set<string>()
  const kv = store.kv
  const read = async (key: string) => (kv ? await kv.get(key) : local.get(key))

  return {
    get: async (channel, threadTs) => parse(await read(threadKey(channel, threadTs))),
    async update(channel, threadTs, change) {
      const key = threadKey(channel, threadTs)
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        // oxlint-disable-next-line no-await-in-loop -- each attempt rereads after a conflict
        const raw = await read(key)
        const next = change(parse(raw))
        if (!next) return undefined
        const value = compareThreadSchema.parse({ ...next, updatedAt: now().toISOString() })
        if (!kv) {
          local.set(key, value)
          return value
        }
        if (!kv.compareAndSet) {
          // oxlint-disable-next-line no-await-in-loop -- see above
          await kv.set(key, value, THREAD_TTL_SECONDS)
          return value
        }
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (await kv.compareAndSet(key, raw, value, THREAD_TTL_SECONDS)) return value
      }
      throw new Error(`comparison thread ${channel}/${threadTs} kept changing`)
    },
    async claimMessage(channel, ts) {
      const key = `slack:compare:message:${channel}:${ts}`
      if (kv?.acquireLease) {
        const holder = randomUUID()
        const lease = await kv.acquireLease(key, holder, MESSAGE_MEMORY_SECONDS, now())
        return lease.holder === holder
      }
      if (claimed.has(key)) return false
      claimed.add(key)
      return true
    },
  }
}
