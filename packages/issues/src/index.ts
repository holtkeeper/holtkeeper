import { z } from 'zod'

/** Where an issue stands, folded from the tracker's own workflow states. */
export type IssueCategory = 'todo' | 'doing' | 'done'

/** One tracker issue as release pages and agents show it. */
export interface Issue {
  /** The key as written in commits, e.g. `ABC-123`. */
  key: string
  title: string
  /** The tracker's own status name, e.g. `In review`. */
  status?: string
  category?: IssueCategory
  /** Issue type, e.g. `Bug` or `Story`. */
  type?: string
  /** The issue's page in the tracker. */
  url?: string
}

/** One issue with the text agents read to know what a change is for. */
export interface IssueDetails extends Issue {
  /** The issue's description as plain text or the tracker's markup, possibly shortened. */
  description?: string
}

/**
 * A read-only issue tracker. `issues` returns the issues it knows among `keys`, in any order;
 * unknown keys are left out rather than failing the call. `issue`, when the tracker offers it,
 * returns one issue with its description, or `undefined` when the tracker does not know the key
 * or its credentials may not read it. Implementations never write.
 */
export interface IssueTracker {
  readonly provider: string
  issues(keys: readonly string[]): Promise<Issue[]>
  issue?(key: string): Promise<IssueDetails | undefined>
}

/** Where looked-up issues are kept; `Store.kv` fits. */
export interface IssueCache {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>
}

const issueSchema = z.object({
  key: z.string(),
  title: z.string(),
  status: z.string().optional(),
  category: z.enum(['todo', 'doing', 'done']).optional(),
  type: z.string().optional(),
  url: z.string().optional(),
})

const cachedSchema = z.object({ issue: issueSchema.nullable() })

/** Options of `cachedTracker`. */
export interface CachedTrackerOptions {
  /** Distinguishes trackers sharing one cache, e.g. a credential id. */
  namespace: string
  /** How long an issue that is not done is reused. Default one hour. */
  openTtlSeconds?: number
  /** How long a done issue is reused. Default one day. */
  doneTtlSeconds?: number
  /** How long a key the tracker does not know is remembered as missing. Default one hour. */
  missingTtlSeconds?: number
}

/**
 * `tracker` behind `cache`: keys found in the cache, including keys remembered as missing, are not
 * asked again until they expire; the rest go to the tracker in one call. A cache that fails to
 * read or write is skipped. `issue` goes to the tracker uncached.
 */
export function cachedTracker(
  tracker: IssueTracker,
  cache: IssueCache,
  options: CachedTrackerOptions,
): IssueTracker {
  const open = options.openTtlSeconds ?? 3600
  const done = options.doneTtlSeconds ?? 86_400
  const missing = options.missingTtlSeconds ?? 3600
  const keyOf = (key: string) => `issues:${tracker.provider}:${options.namespace}:${key}`
  const details = tracker.issue?.bind(tracker)
  return {
    provider: tracker.provider,
    // Details are read once per review or task, so they are not worth caching.
    ...(details && { issue: details }),
    async issues(keys) {
      const wanted = [...new Set(keys)]
      const found: Issue[] = []
      const ask: string[] = []
      await Promise.all(
        wanted.map(async (key) => {
          const parsed = cachedSchema.safeParse(await cache.get(keyOf(key)).catch(() => undefined))
          if (!parsed.success) ask.push(key)
          else if (parsed.data.issue) found.push(parsed.data.issue)
        }),
      )
      if (ask.length === 0) return found
      const fresh = await tracker.issues(ask)
      const byKey = new Map(fresh.map((issue) => [issue.key, issue]))
      await Promise.all(
        ask.map((key) => {
          const issue = byKey.get(key)
          const ttl = !issue ? missing : issue.category === 'done' ? done : open
          return cache.set(keyOf(key), { issue: issue ?? null }, ttl).catch(() => {})
        }),
      )
      return [...found, ...fresh]
    },
  }
}

/**
 * The issues of `keys` by key, from `tracker` when there is one. Never throws: without a tracker,
 * or when it fails (reported to `onError`), the result is empty and callers show plain keys.
 */
export async function issuesByKey(
  tracker: IssueTracker | undefined,
  keys: readonly string[],
  onError: (error: unknown) => void = () => {},
): Promise<Record<string, Issue>> {
  if (!tracker || keys.length === 0) return {}
  try {
    const issues = await tracker.issues(keys)
    return Object.fromEntries(issues.map((issue) => [issue.key, issue]))
  } catch (error) {
    onError(error)
    return {}
  }
}

/** Ticket keys as written in titles, branch names and commits, e.g. `ABC-123`. */
const ISSUE_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6})(?![A-Za-z0-9])/g

/**
 * The ticket keys found in `texts`, in order of first appearance and without repeats. Keys are
 * matched as written; upper-case a branch name first to find `abc-123` in it.
 */
export function issueKeysIn(...texts: readonly (string | undefined)[]): string[] {
  const keys: string[] = []
  for (const text of texts)
    for (const match of (text ?? '').matchAll(ISSUE_KEY))
      if (match[1] && !keys.includes(match[1])) keys.push(match[1])
  return keys
}

/**
 * The details of the issues among `keys` the tracker can read, in key order; empty without a
 * tracker or when it cannot read details. Unknown and unreadable keys are left out; a tracker
 * failure is thrown.
 */
export async function issueDetails(
  tracker: IssueTracker | undefined,
  keys: readonly string[],
): Promise<IssueDetails[]> {
  if (!tracker?.issue || !keys.length) return []
  const found = await Promise.all(keys.map(async (key) => tracker.issue?.(key)))
  return found.filter((issue) => issue !== undefined)
}
