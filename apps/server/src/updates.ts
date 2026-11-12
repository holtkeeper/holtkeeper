import type { RepoTarget } from '@holtkeeper/access'
import { parentGroup } from '@holtkeeper/access'
import type { RepoUpdatesSummary } from '@holtkeeper/api'
import { type HoltkeeperConfig, resolveRepo, rootGroups } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { groupRepositories, staticPrefix } from '@holtkeeper/jobs'
import { type Limiter, resolveLimitPolicy } from '@holtkeeper/limits'
import { resolveSetting } from '@holtkeeper/settings'
import type { KvStore, SettingEntry, Store } from '@holtkeeper/store'
import {
  DEFAULT_POLL_SHARE,
  type PollingConfig,
  type RepoCursor,
  createSpendWindow,
  firstDueAt,
  pollRepository,
  pollingConfig,
  pollingSetting,
  stretchFactors,
} from '@holtkeeper/updates'

import { type ServerDeps, repoTarget } from './context.ts'
import type { EventDispatcher } from './events.ts'
import { forgeLimitKey, globalLimits } from './limits.ts'
import { queueNewRepoJobs } from './new-repos.ts'

const seenKey = (repo: RepoRef) => `webhook-seen:${repo.forge}:${repo.path}`
const stateKey = (repo: RepoRef) => `poll:${repo.forge}:${repo.path}`
const lockKey = (repo: RepoRef) => `poll-lock:${repo.forge}:${repo.path}`
const groupKey = (group: string) => `poll-group:${group}`
const repoId = (repo: RepoRef) => `${repo.forge}:${repo.path}`

/** A repository counts as reached by webhooks for this long after a delivery about it. */
const WEBHOOK_FRESH_MS = 24 * 3_600_000
const LOCK_TTL_SECONDS = 120
const REPO_LIST_TTL_MS = 30 * 60_000
/** Attempts kept per repository and per group. */
const MAX_ATTEMPTS = 20

const exactIncludes = (group: HoltkeeperConfig['groups'][string]): RepoRef[] =>
  group.include
    .filter((path) => staticPrefix(path) === path)
    .map((path) => ({ forge: group.forge, path }))

/**
 * Repositories the poller last listed for the config's root groups (none without `kv`), plus their
 * exact include paths; read from the store only, so it never calls a forge. Subgroups add nothing:
 * their members are members of the parent.
 */
export async function listedRepos(
  kv: KvStore | undefined,
  config: HoltkeeperConfig,
): Promise<RepoRef[]> {
  const groups = rootGroups(config).flatMap((name) => {
    const group = config.groups[name]
    return group ? [[name, group] as const] : []
  })
  const listings = kv ? await Promise.all(groups.map(([name]) => kv.get(groupKey(name)))) : []
  const found = new Map<string, RepoRef>()
  for (const listing of listings)
    if (isGroupListing(listing)) for (const repo of listing.repos) found.set(repoId(repo), repo)
  for (const [, group] of groups)
    for (const repo of exactIncludes(group)) found.set(repoId(repo), repo)
  return [...found.values()]
}

/** Records that a webhook delivered an event about `repo`. */
export async function markWebhookSeen(kv: KvStore, repo: RepoRef, now: Date) {
  await kv.set(seenKey(repo), now.toISOString(), 7 * 86_400)
}

/** Forgets the last webhook delivery about `repo`, so polling takes over again at once. */
export async function forgetWebhookSeen(kv: KvStore, repo: RepoRef) {
  await kv.delete(seenKey(repo))
}

/**
 * How each of `repos` learns about forge changes, keyed `forge:path`, from stored state only, all
 * keys read at once: `webhook` after a delivery in the last day, `polling` when the `polling` entry
 * among `entries` covering it is enabled, else `off`.
 */
export async function repoUpdatesSummaries(
  kv: KvStore,
  entries: readonly SettingEntry[],
  repos: readonly RepoTarget[],
  now: Date,
): Promise<Map<string, RepoUpdatesSummary>> {
  const stored = await Promise.all(
    repos.map((repo) => Promise.all([kv.get(seenKey(repo)), kv.get(stateKey(repo))])),
  )
  return new Map(
    repos.map((repo, index) => {
      const [seen, state] = stored[index] ?? []
      return [repoId(repo), updatesSummary(entries, repo, now, seen, state)]
    }),
  )
}

function updatesSummary(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
  now: Date,
  seen: unknown,
  stored: unknown,
): RepoUpdatesSummary {
  const state = isPollState(stored) ? stored : {}
  const entry = resolveSetting(entries, pollingSetting.key, repo)
  const polling = pollingConfig(entry && !entry.secret ? entry.value : undefined)
  const last = {
    ...(state.lastPolledAt && { lastPolledAt: state.lastPolledAt }),
    ...(state.lastError && { lastError: state.lastError }),
  }
  if (typeof seen === 'string' && now.getTime() - Date.parse(seen) < WEBHOOK_FRESH_MS)
    return { via: 'webhook', ...last }
  if (!polling.enabled) return { via: 'off', ...last }
  return { via: 'polling', intervalMs: state.intervalMs ?? polling.intervalMs, ...last }
}

/** How an attempt started: on its schedule or from a person. */
type AttemptTrigger = 'scheduled' | 'manual'

/** One poll of a repository. */
interface PollAttempt {
  at: string
  trigger: AttemptTrigger
  durationMs: number
  events?: number
  enqueued?: number
  requests?: number
  error?: string
}

/** One listing of a group's repositories on its forge. */
interface ListingAttempt {
  at: string
  trigger: AttemptTrigger
  durationMs: number
  repos?: number
  error?: string
}

/** What polling knows about a group's repositories, as stored. */
interface GroupListing {
  /** Repositories of the last successful listing. */
  repos: RepoRef[]
  /** What the include patterns matched in that listing, before exclude patterns applied. */
  matched?: RepoRef[]
  listedAt?: string
  /** Newest first. */
  attempts: ListingAttempt[]
}

/** Polling state of one repository, as stored. */
interface PollState {
  cursor?: RepoCursor
  lastPolledAt?: string
  /** Requests the last poll took. */
  lastRequests?: number
  lastEvents?: number
  lastError?: string
  nextAt?: string
  /** Interval in effect, after the webhook fallback and the key's budget. */
  intervalMs?: number
  /** How much the key's budget slowed polling down; 1 when it did not. */
  stretch?: number
  /** Newest first. */
  attempts?: PollAttempt[]
}

/** How a repository is polled right now. */
interface PollStatus {
  config: PollingConfig
  /** Limiter key of the forge credential the polls draw from. */
  key: string
  /** Last webhook delivery about the repository, ISO 8601. */
  webhookSeenAt?: string
  /** Whether webhooks currently stand in for regular polling. */
  viaWebhook: boolean
  state: PollState
}

interface PollerOptions {
  config: HoltkeeperConfig
  store: Store
  kv: KvStore
  dispatch: EventDispatcher
  limiter?: Limiter
  /** Limiter key of a forge: its credential id, or `forge:<id>` for file forges. */
  keyOf: (forgeId: string) => string
  now: () => Date
  /** How often due repositories are looked for. Default 15 s. */
  tickMs?: number
  /** Receives repositories a group listing found that no stored listing had. */
  onNewRepos?: (repos: RepoRef[]) => Promise<unknown>
  log: (line: string) => void
}

const isPollState = (value: unknown): value is PollState =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isGroupListing = (value: unknown): value is GroupListing =>
  typeof value === 'object' && value !== null && 'repos' in value && 'attempts' in value

const withAttempt = <T>(attempts: readonly T[] | undefined, attempt: T) =>
  [attempt, ...(attempts ?? [])].slice(0, MAX_ATTEMPTS)

/** The interval a repository's settings ask for now; `undefined` while webhooks replace polling. */
const wantedInterval = (current: PollStatus) =>
  current.viaWebhook
    ? current.config.withWebhookMs === undefined
      ? undefined
      : Math.max(current.config.intervalMs, current.config.withWebhookMs)
    : current.config.intervalMs

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Rough requests of one poll before the first one measured it. */
const estimateCost = (config: PollingConfig) =>
  config.events.length + (config.events.includes('notes') ? 2 : 0)

/**
 * Polls repositories for forge changes and hands them to the event dispatcher. `tick()` polls the
 * repositories that are due: repositories with `polling` enabled are spread over their interval,
 * slowed down evenly per forge credential when the credential's polling budget (`pollShare` of
 * its `requestsPerMinute`) cannot keep up, and held back while the credential is saturated. One
 * poll per credential runs at a time; a store lease keeps two processes from polling the same
 * repository at once. A group listing that finds repositories no stored listing of any group had
 * hands them to `onNewRepos`.
 */
function createPoller(options: PollerOptions) {
  const { config, store, kv, limiter } = options
  const spend = createSpendWindow()
  const busy = new Set<string>()

  const readStored = async (group: string): Promise<GroupListing | undefined> => {
    const value = await kv.get(groupKey(group))
    return isGroupListing(value) ? value : undefined
  }

  /**
   * A subgroup's listing, read from its parent's stored one: `matched` holds every member of the
   * parent (the candidates its patterns pick from), `repos` the ones `resolveRepo` puts in it.
   */
  const subgroupListing = async (
    group: string,
    parent: string,
  ): Promise<GroupListing | undefined> => {
    const definition = config.groups[group]
    const stored = await readStored(parent)
    if (!definition || !stored) return undefined
    return {
      repos: stored.repos.filter((repo) => resolveRepo(config, repo).groups.includes(group)),
      matched: stored.repos,
      ...(stored.listedAt && { listedAt: stored.listedAt }),
      attempts: stored.attempts,
    }
  }

  const readListing = async (group: string): Promise<GroupListing | undefined> => {
    const parent = parentGroup(group)
    return parent === undefined ? readStored(group) : subgroupListing(group, parent)
  }

  /**
   * Lists a group's repositories on its forge now and records the attempt. A subgroup is never
   * listed: it gets the view of its parent's stored listing.
   */
  const listGroup = async (group: string, trigger: AttemptTrigger): Promise<GroupListing> => {
    if (parentGroup(group) !== undefined)
      return (await readListing(group)) ?? { repos: [], matched: [], attempts: [] }
    const started = options.now()
    const previous = await readStored(group)
    const attempt = (result: { repos?: number; error?: string }): ListingAttempt => ({
      at: started.toISOString(),
      trigger,
      durationMs: options.now().getTime() - started.getTime(),
      ...result,
    })
    let listing: GroupListing
    let added: RepoRef[] = []
    try {
      const definition = config.groups[group]
      const matched = definition
        ? await groupRepositories({
            ...config,
            groups: { ...config.groups, [group]: { ...definition, exclude: [] } },
          })(group)
        : []
      const repos = matched.filter(
        (repo) => !definition?.exclude.some((pattern) => new Bun.Glob(pattern).match(repo.path)),
      )
      if (options.onNewRepos) {
        const known = new Set<string>()
        for (const name of rootGroups(config)) {
          // oxlint-disable-next-line no-await-in-loop -- one store read per group
          const stored = name === group ? previous : await readStored(name)
          for (const repo of stored?.repos ?? []) known.add(repoId(repo))
        }
        added = repos.filter((repo) => !known.has(repoId(repo)))
      }
      listing = {
        repos,
        matched,
        listedAt: started.toISOString(),
        attempts: withAttempt(previous?.attempts, attempt({ repos: repos.length })),
      }
    } catch (error) {
      options.log(`polling: could not list group ${group}: ${messageOf(error)}`)
      listing = {
        repos: previous?.repos ?? [],
        ...(previous?.matched && { matched: previous.matched }),
        ...(previous?.listedAt && { listedAt: previous.listedAt }),
        attempts: withAttempt(previous?.attempts, attempt({ error: messageOf(error) })),
      }
    }
    await kv.set(groupKey(group), listing)
    if (added.length && options.onNewRepos)
      try {
        await options.onNewRepos(added)
      } catch (error) {
        options.log(`polling: new repositories of group ${group}: ${messageOf(error)}`)
      }
    return listing
  }

  /**
   * Repositories of every root group, listed again once the last attempt is older than 30 minutes,
   * plus exact repositories the `polling` setting names. A group that never listed falls back to
   * its exact include paths.
   */
  const knownRepos = async (): Promise<RepoRef[]> => {
    const now = options.now().getTime()
    const found = new Map<string, RepoRef>()
    for (const name of rootGroups(config)) {
      const group = config.groups[name]
      if (!group) continue
      // oxlint-disable-next-line no-await-in-loop -- groups are listed one after another
      const stored = await readStored(name)
      const lastAt = stored?.attempts[0]?.at
      const listing =
        stored && lastAt && now - Date.parse(lastAt) < REPO_LIST_TTL_MS
          ? stored
          : // oxlint-disable-next-line no-await-in-loop
            await listGroup(name, 'scheduled')
      for (const repo of listing.repos) found.set(repoId(repo), repo)
      if (!listing.listedAt) for (const repo of exactIncludes(group)) found.set(repoId(repo), repo)
    }
    for (const entry of await store.settings.list(pollingSetting.key))
      for (const pattern of entry.scope.repos ?? []) {
        const separator = pattern.indexOf(':')
        const path = pattern.slice(separator + 1)
        if (separator > 0 && staticPrefix(path) === path)
          found.set(pattern, { forge: pattern.slice(0, separator), path })
      }
    return [...found.values()].filter((repo) => repo.forge in config.forges)
  }

  const budgetOf = async (key: string, forgeId: string) => {
    const policy =
      limiter?.policy(key) ??
      resolveLimitPolicy(
        { id: key, kind: config.forges[forgeId]?.kind ?? 'unknown' },
        globalLimits(await store.settings.list('limits.credentials')),
      )
    return policy.requestsPerMinute === undefined
      ? undefined
      : policy.requestsPerMinute * (policy.pollShare ?? DEFAULT_POLL_SHARE)
  }

  const readState = async (repo: RepoRef): Promise<PollState> => {
    const value = await kv.get(stateKey(repo))
    return isPollState(value) ? value : {}
  }

  /** The setting, webhook freshness and stored state of a repository. */
  const status = async (repo: RepoRef): Promise<PollStatus> => {
    const entry = resolveSetting(
      await store.settings.list(pollingSetting.key),
      pollingSetting.key,
      repoTarget(config, repo),
    )
    const settings = pollingConfig(entry && !entry.secret ? entry.value : undefined)
    const stored = await kv.get(seenKey(repo))
    const seen = typeof stored === 'string' ? stored : undefined
    const viaWebhook =
      seen !== undefined && options.now().getTime() - Date.parse(seen) < WEBHOOK_FRESH_MS
    return {
      config: settings,
      key: options.keyOf(repo.forge),
      ...(seen && { webhookSeenAt: seen }),
      viaWebhook,
      state: await readState(repo),
    }
  }

  /** Polls one repository now and dispatches what changed; never throws. */
  const pollOne = async (
    repo: RepoRef,
    settings: PollingConfig,
    key: string,
    trigger: AttemptTrigger,
  ) => {
    const holder = crypto.randomUUID()
    if (kv.acquireLease) {
      const lease = await kv.acquireLease(lockKey(repo), holder, LOCK_TTL_SECONDS)
      if (lease.holder !== holder) return { skipped: 'another process is polling it' }
    }
    const started = options.now()
    const state = await readState(repo)
    const attempt = (result: Omit<PollAttempt, 'at' | 'trigger' | 'durationMs'>): PollAttempt => ({
      at: started.toISOString(),
      trigger,
      durationMs: options.now().getTime() - started.getTime(),
      ...result,
    })
    try {
      const definition = config.forges[repo.forge]
      if (!definition) throw new Error(`forge ${repo.forge} is not configured`)
      const pushesWanted = config.jobs?.onPush !== undefined
      const result = await pollRepository({
        forge: definition.create(),
        repo,
        cursor: state.cursor,
        now: started,
        // Listing every branch costs requests; only pay for it while something reacts to pushes.
        events: pushesWanted
          ? settings.events
          : settings.events.filter((kind) => kind !== 'pushes'),
      })
      spend.record(key, started.getTime(), result.requests)
      let enqueued = 0
      for (const event of result.events) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- events of a repository keep their order
          enqueued += (await options.dispatch(event, { actor: 'poll', via: 'poll' })).enqueued
            .length
        } catch (error) {
          options.log(`polling: ${repoId(repo)}: ${event.kind} failed: ${messageOf(error)}`)
        }
      }
      const next: PollState = {
        ...state,
        cursor: result.cursor,
        lastPolledAt: started.toISOString(),
        lastRequests: result.requests,
        lastEvents: result.events.length,
        attempts: withAttempt(
          state.attempts,
          attempt({ events: result.events.length, enqueued, requests: result.requests }),
        ),
      }
      delete next.lastError
      await kv.set(stateKey(repo), next)
      return { events: result.events.length, enqueued }
    } catch (error) {
      spend.record(key, started.getTime(), 1)
      await kv.set(stateKey(repo), {
        ...state,
        lastPolledAt: started.toISOString(),
        lastError: messageOf(error),
        attempts: withAttempt(state.attempts, attempt({ error: messageOf(error) })),
      } satisfies PollState)
      return { error: messageOf(error) }
    } finally {
      await kv.releaseLease?.(lockKey(repo), holder)
    }
  }

  const tick = async () => {
    const now = options.now().getTime()
    const due = new Map<string, { repo: RepoRef; settings: PollingConfig; at: number }[]>()
    const planned: { repo: RepoRef; current: PollStatus; wanted: number }[] = []
    for (const repo of await knownRepos()) {
      // oxlint-disable-next-line no-await-in-loop -- a few store reads per repository
      const current = await status(repo)
      if (!current.config.enabled) continue
      const wanted = wantedInterval(current)
      if (wanted !== undefined) planned.push({ repo, current, wanted })
    }
    const budgets = new Map<string, number | undefined>()
    for (const { repo, current } of planned)
      if (!budgets.has(current.key))
        budgets.set(current.key, await budgetOf(current.key, repo.forge))
    const factors = stretchFactors(
      planned.map(({ current, wanted }) => ({
        key: current.key,
        intervalMs: wanted,
        cost: current.state.lastRequests ?? estimateCost(current.config),
      })),
      (key) => ({ requestsPerMinute: budgets.get(key) }),
    )
    for (const { repo, current, wanted } of planned) {
      const stretch = factors.get(current.key) ?? 1
      const intervalMs = Math.round(wanted * stretch)
      const { state } = current
      const at = state.lastPolledAt
        ? Date.parse(state.lastPolledAt) + intervalMs
        : state.nextAt
          ? Date.parse(state.nextAt)
          : firstDueAt(repoId(repo), now, intervalMs)
      const nextAt = new Date(at).toISOString()
      if (state.nextAt !== nextAt || state.intervalMs !== intervalMs || state.stretch !== stretch)
        // oxlint-disable-next-line no-await-in-loop
        await kv.set(stateKey(repo), { ...state, nextAt, intervalMs, stretch } satisfies PollState)
      if (at > now) continue
      const list = due.get(current.key) ?? []
      list.push({ repo, settings: current.config, at })
      due.set(current.key, list)
    }

    await Promise.all(
      [...due].map(async ([key, list]) => {
        if (busy.has(key)) return
        busy.add(key)
        try {
          const budget = budgets.get(key)
          for (const { repo, settings } of list.toSorted((a, b) => a.at - b.at)) {
            // oxlint-disable-next-line no-await-in-loop -- one poll per credential at a time
            if (limiter && (await limiter.saturated(key))) break
            const cost = (await readState(repo)).lastRequests ?? estimateCost(settings)
            if (budget !== undefined && spend.used(key, options.now().getTime()) + cost > budget)
              break
            // oxlint-disable-next-line no-await-in-loop
            await pollOne(repo, settings, key, 'scheduled')
          }
        } finally {
          busy.delete(key)
        }
      }),
    )
  }

  return {
    tick,
    status,
    /** Polls one repository now, whatever its schedule and whether polling is enabled for it. */
    async pollNow(repo: RepoRef) {
      const current = await status(repo)
      return pollOne(repo, current.config, current.key, 'manual')
    },
    /** The stored listing of a group; a subgroup's is narrowed from its parent's. */
    listing: readListing,
    /** When the next scheduled listing of a group is due; absent before its first listing. */
    nextListingAt: (listing: GroupListing | undefined) => {
      const lastAt = listing?.attempts[0]?.at
      return lastAt ? new Date(Date.parse(lastAt) + REPO_LIST_TTL_MS).toISOString() : undefined
    },
    /** Lists a group's repositories now; the next tick polls what it found. */
    listGroup: (group: string) => listGroup(group, 'manual'),
    /** Ticks every `tickMs` until the returned function is called; a leader duty. */
    start() {
      let running: Promise<void> | undefined
      const run = () => {
        running ??= tick()
          .catch((error: unknown) => options.log(`polling: ${messageOf(error)}`))
          .finally(() => {
            running = undefined
          })
      }
      const timer = setInterval(run, options.tickMs ?? 15_000)
      run()
      return async () => {
        clearInterval(timer)
        await running
      }
    },
  }
}

export type Poller = ReturnType<typeof createPoller>

/** The poller of a server, drawing from its limiter; `undefined` without a key-value store. */
export function serverPoller(
  deps: ServerDeps,
  dispatch: EventDispatcher,
  log: (line: string) => void = () => {},
): Poller | undefined {
  const kv = deps.store.kv
  if (!kv) return undefined
  return createPoller({
    config: deps.config,
    store: deps.store,
    kv,
    dispatch,
    ...(deps.limiter && { limiter: deps.limiter }),
    keyOf: (forgeId) =>
      deps.configSource?.effective().forges[forgeId]?.credentialId ?? forgeLimitKey(forgeId),
    now: deps.now,
    onNewRepos: (repos) => queueNewRepoJobs(deps, repos, { log }),
    log,
  })
}
