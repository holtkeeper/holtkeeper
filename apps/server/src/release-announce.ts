import { randomUUID } from 'node:crypto'

import {
  type ApiChange,
  type ApiPackage,
  type ApiSurfaceData,
  apiSurfaceDataSchema,
  diffPackage,
} from '@holtkeeper/api-surface'
import type { RepoRef, TagRecord } from '@holtkeeper/forge'
import {
  type AnnouncedTag,
  type AnnouncementNotes,
  type AnnouncementNotesPackage,
  type ReleaseAnnounceSettings,
  type ReleaseEntry,
  type ReleaseSettings,
  announcedTag,
  breakingEntries,
  forgeLinks,
  packageEntries,
  previousTag,
  rangeChanges,
  releaseAnnounceSettingKey,
  releaseAnnounceSettings,
  releaseSettings,
  releaseSettingsKey,
  releaseTarget,
  sectionOrder,
  sectionTitles,
  writeAnnouncementNotes,
} from '@holtkeeper/release'
import { resolveSetting } from '@holtkeeper/settings'
import { type Job, type KvStore, type SettingEntry, keepKv, updateKv } from '@holtkeeper/store'
import { declaredMembers } from '@holtkeeper/usages'
import { webPaths, webUrl } from '@holtkeeper/web-paths'
import { z } from 'zod'

import { type UsageIndex, createUsageIndex, impactOfChanges } from './api-surface/usages.ts'
import { type ServerDeps, repoKey, repoTarget } from './context.ts'
import { automaticJobReady } from './jobs.ts'
import {
  type AffectedRepository,
  type AnnouncedVersion,
  type AnnouncementContent,
  type AnnouncementImpact,
  announcementMessage,
} from './slack/announcement.ts'
import { type SlackPoster, slackWebPoster } from './slack/client.ts'
import { slackConnection } from './slack/connection.ts'
import { listedRepos } from './updates.ts'
import { crossTeamPolicy } from './visibility.ts'

const INDEX_KIND = 'api-surface'
const INDEX_KEY = 'release:announce:repos'
/** How long an announcement waits for the API index before it is posted without impact. */
export const ANNOUNCE_INDEX_TIMEOUT_MS = 30 * 60_000
/** How long a posted announcement still gets its impact once the index lands. */
const IMPACT_FOLLOW_MS = 24 * 3_600_000
/** Tags of a repository are polled at most this often; webhooks report them at once. */
const POLL_MS = 15 * 60_000
const TAG_LIMIT = 100
/** How far back the version before a rarely released package is looked for. */
const TAG_LIMIT_DEEP = 1000
/** A claim older than this belongs to a process that died while posting. */
const STUCK_MS = 15 * 60_000
/** A batch Slack keeps refusing is given up this long after it opened. */
const RETRY_FOR_MS = 24 * 3_600_000
/** An event that lost the baseline race to a poll this recent still counts its tag as new. */
const BASELINE_RACE_MS = 60_000
/** Slack errors retrying cannot fix. */
const FINAL_ERRORS: ReadonlySet<string> = new Set([
  'channel_not_found',
  'is_archived',
  'invalid_blocks',
  'invalid_arguments',
  'msg_too_long',
  'no_text',
])
const SEEN_MAX = 1000
const KEEP_POSTED_MS = 7 * 86_400_000
const KEEP_POSTED = 20
const RECORD_PAGE = 200
const CAS_ATTEMPTS = 20
const FINAL_JOBS: ReadonlySet<Job['status']> = new Set([
  'succeeded',
  'failed',
  'blocked',
  'canceled',
])
const AGENT_ACTOR = 'agent:release-announce'

const stateKey = (repo: RepoRef) => `release:announce:${repoKey(repo)}`

const tagSchema = z.object({
  name: z.string(),
  sha: z.string(),
  package: z.string().optional(),
  version: z.string(),
})

const batchTagSchema = tagSchema.extend({ previous: tagSchema.optional() })

const notesSchema = z.array(
  z.object({
    name: z.string(),
    overview: z.string(),
    highlights: z.array(z.string()),
    breaking: z.array(z.object({ change: z.string(), migration: z.string().optional() })),
  }),
)

const batchSchema = z.object({
  id: z.string(),
  openedAt: z.string(),
  closesAt: z.string(),
  tags: z.array(batchTagSchema),
  /** `api-surface` jobs the announcement waits for. */
  jobs: z.array(z.string()),
  /** Whether impact is wanted and the API index can be made; without it nothing is waited for. */
  indexing: z.boolean(),
  /** Tags whose `api-surface` jobs are queued (or not needed); the rest may still get some. */
  queuedFor: z.array(z.string()).default([]),
  status: z.enum(['collecting', 'posting', 'posted']),
  claimedAt: z.string().optional(),
  /** Posts Slack refused so far; the next try waits until `retryAt`. */
  attempts: z.number().int().default(0),
  retryAt: z.string().optional(),
  posts: z.array(z.object({ channel: z.string(), ts: z.string() })).default([]),
  impact: z.enum(['included', 'pending', 'none']).optional(),
  postedAt: z.string().optional(),
  updating: z.string().optional(),
  notes: notesSchema.optional(),
  /** The notes were asked for once; a failed or refused call is not repeated. */
  notesTried: z.boolean().optional(),
})

const stateSchema = z.object({
  baselineAt: z.string(),
  seen: z.array(z.string()),
  polledAt: z.string().optional(),
  batches: z.array(batchSchema),
})

/** One release announcement: the tags found together, and how far posting it got. */
type AnnounceBatch = z.infer<typeof batchSchema>
/** What the store keeps per repository: the baseline, the handled tags and the batches. */
type AnnounceState = z.infer<typeof stateSchema>
type BatchTag = z.infer<typeof batchTagSchema>

const indexSchema = z.array(z.object({ forge: z.string(), path: z.string() }))

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const plainTag = (tag: AnnouncedTag): z.infer<typeof tagSchema> => ({
  name: tag.name,
  sha: tag.sha,
  ...(tag.package !== undefined && { package: tag.package }),
  version: tag.version,
})

const originRepo = (origin: string): RepoRef => {
  const at = origin.indexOf(':')
  return { forge: origin.slice(0, at), path: origin.slice(at + 1) }
}

/** Changes of a diff that break callers: removed exports, members removed from a declaration. */
const breakingApiChanges = (changes: readonly ApiChange[]) =>
  changes.filter(
    (change) =>
      change.change === 'removed' ||
      (change.change === 'changed' &&
        [...declaredMembers(change.before)].some(
          (name) => !declaredMembers(change.after).has(name),
        )),
  )

const describeApiChange = (change: ApiChange) => {
  if (change.change === 'removed') return `\`${change.name}\` was removed`
  const after = declaredMembers(change.after)
  const lost = [...declaredMembers(change.before)].filter((name) => !after.has(name))
  return `\`${change.name}\` no longer has ${lost.map((name) => `\`${name}\``).join(', ')}`
}

/** Whether prose names an export as a word of its own (`Widget`, not `Widgets`). */
const mentions = (text: string, name: string) =>
  new RegExp(`(^|[^\\w$])${name.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&')}([^\\w$]|$)`, 'u').test(
    text,
  )

/** Refs an `api-surface` record of a tag may carry: the release target, the tag, the commit. */
const refsOf = (tag: z.infer<typeof tagSchema>) => [releaseTarget(tag), tag.name, tag.sha]

/** Usages of every repository but the releasing one. */
const usageFilter = (repo: RepoRef) => (other: RepoRef) => repoKey(other) !== repoKey(repo)

/** Posts to every channel in order; answers the messages Slack accepted and the errors. */
const postAll = async (
  poster: SlackPoster,
  channels: readonly string[],
  message: { text: string; blocks?: readonly Record<string, unknown>[] },
) => {
  const posts: { channel: string; ts: string }[] = []
  const errors: string[] = []
  for (const channel of channels) {
    // oxlint-disable-next-line no-await-in-loop -- channels in order, within Slack's rate limits
    const result = await poster.post({ channel, ...message })
    if (result.ok && result.ts) posts.push({ channel: result.channel ?? channel, ts: result.ts })
    else errors.push(result.error ?? 'unknown_error')
  }
  return { posts, errors }
}

/** Minutes before the next try after `attempts` refused posts: 1, 2, 4, … up to an hour. */
const bare = (version: string | undefined) => version?.replace(/^v(?=\d)/, '')

const retryDelayMs = (attempts: number) => Math.min(2 ** Math.max(attempts - 1, 0), 60) * 60_000

/** Whether two repositories share a team: a config group, or neither has one. */
const sameTeam = (a: readonly string[], b: readonly string[]) =>
  (a.length === 0 && b.length === 0) || a.some((group) => b.includes(group))

/** Release announcements in Slack; see `createReleaseAnnouncer`. */
export interface ReleaseAnnouncer {
  /** A tag reached the repository (webhook or polling). */
  onTag(repo: RepoRef, tag: { name: string; sha: string }): Promise<void>
  /** An `api-surface` job ended: announcements waiting for it may go out or get their impact. */
  indexFinished(job: Job): Promise<void>
  /** Polls due repositories for new tags and moves every open announcement on. */
  sweep(): Promise<void>
  /** Polls one repository's tags now, as the sweep does. */
  poll(repo: RepoRef): Promise<void>
  /** Posts or updates what is due for one repository. */
  advance(repo: RepoRef): Promise<void>
  /** The stored state of a repository: baseline, handled tags and batches. */
  stateOf(repo: RepoRef): Promise<AnnounceState | undefined>
}

/** Options of `createReleaseAnnouncer`. */
export interface ReleaseAnnouncerOptions {
  /** Moves a batch on in-process once its window closes; the sweep does it anyway. Default true. */
  timers?: boolean
  usages?: UsageIndex
  log?: (line: string) => void
}

/**
 * Release announcements: a Slack message per new version of repositories whose
 * `releases.announce` names channels, whatever created the tag. Tags come from forge events and
 * from polling in the sweep; the first look at a repository only records a baseline, so history is
 * never announced. Tags found within `groupWindowMinutes` of the first one make one batch (a
 * monorepo's packages released together). For each new tag (and the version before it) an
 * `api-surface` job is queued unless the record exists; the batch is posted once its window closed
 * and those jobs ended, with the upgrade impact computed from the exact records of both versions
 * and the newest `usages` records of connected repositories. Without the records 30 minutes after
 * the first tag (or when indexing failed) it goes out with "Compatibility analysis is still
 * running", and the message is updated in place once they land (for a day, then marked
 * unavailable). State lives in one `kv` document per repository, changed with `compareAndSet`, so
 * across processes a batch is created once and posted at most once: a process that dies while
 * posting leaves the batch given up after 15 minutes rather than posted twice. When Slack accepts
 * the message in no channel (or no credential is set) the batch is tried again with backoff for a
 * day, unless Slack's error is final (`channel_not_found`, …). Under `access.crossTeam: off` the
 * impact names only repositories of the releasing repository's teams and counts the others; under
 * `metadata` it leaves out file links into other teams' repositories. Nothing here throws:
 * failures are logged.
 */
export function createReleaseAnnouncer(
  deps: ServerDeps,
  options: ReleaseAnnouncerOptions = {},
): ReleaseAnnouncer {
  const { config, store } = deps
  const log = options.log ?? ((line: string) => console.error(line))
  const usages = options.usages ?? createUsageIndex({ analyses: store.analyses })
  const timers = options.timers ?? true
  const kv: KvStore | undefined = store.kv
  const chains = new Map<string, Promise<void>>()

  const nowIso = () => deps.now().toISOString()

  const read = async (repo: RepoRef) => {
    const raw = await kv?.get(stateKey(repo))
    return { raw, state: stateSchema.safeParse(raw).data }
  }

  /**
   * Applies `change` to the repository's state atomically: rereads and retries while another
   * process changed it. `change` answering `undefined` leaves it as it is.
   */
  const update = async (
    repo: RepoRef,
    change: (state: AnnounceState | undefined) => AnnounceState | undefined,
  ): Promise<{ state: AnnounceState | undefined; changed: boolean }> => {
    if (!kv) return { state: undefined, changed: false }
    let kept: AnnounceState | undefined
    let skipped = false
    const written = await updateKv(
      kv,
      stateKey(repo),
      (raw) => {
        const state = stateSchema.safeParse(raw).data
        const next = change(state === undefined ? undefined : structuredClone(state))
        kept = state
        skipped = next === undefined
        return next ?? keepKv
      },
      CAS_ATTEMPTS,
    )
    if (written) return { state: written, changed: true }
    if (!skipped) throw new Error(`announcement state of ${repoKey(repo)} kept changing`)
    return { state: kept, changed: false }
  }

  const indexed = async () => indexSchema.safeParse(await kv?.get(INDEX_KEY)).data ?? []

  const changeIndex = async (change: (known: z.infer<typeof indexSchema>) => typeof known) => {
    if (!kv) return
    await updateKv(
      kv,
      INDEX_KEY,
      (raw) => {
        const known = indexSchema.safeParse(raw).data ?? []
        const next = change(known)
        return next === known ? keepKv : next
      },
      CAS_ATTEMPTS,
    )
  }

  const remember = (repo: RepoRef) =>
    changeIndex((known) =>
      known.some((entry) => repoKey(entry) === repoKey(repo))
        ? known
        : [...known, { forge: repo.forge, path: repo.path }],
    )

  const forget = async (repo: RepoRef) => {
    await kv?.delete(stateKey(repo))
    await changeIndex((known) =>
      known.some((entry) => repoKey(entry) === repoKey(repo))
        ? known.filter((entry) => repoKey(entry) !== repoKey(repo))
        : known,
    )
  }

  const settingOf = async <T>(
    key: string,
    repo: RepoRef,
    parse: (value: unknown) => T,
    entries?: readonly SettingEntry[],
  ) =>
    parse(
      resolveSetting(entries ?? (await store.settings.list(key)), key, repoTarget(config, repo))
        ?.value,
    )

  const announceOf = (
    repo: RepoRef,
    entries?: readonly SettingEntry[],
  ): Promise<ReleaseAnnounceSettings> =>
    settingOf(releaseAnnounceSettingKey, repo, releaseAnnounceSettings, entries)

  const flowOf = (repo: RepoRef): Promise<ReleaseSettings> =>
    settingOf(releaseSettingsKey, repo, releaseSettings)

  const languageOf = async (repo: RepoRef, announce: ReleaseAnnounceSettings) =>
    announce.language ??
    (await settingOf('analyzers.review', repo, (value) => {
      const language = z.object({ language: z.string().min(1) }).safeParse(value).data?.language
      return language
    })) ??
    'English'

  const forgeOf = (repo: RepoRef) => config.forges[repo.forge]?.create()

  const listTags = async (repo: RepoRef): Promise<TagRecord[]> => {
    const forge = forgeOf(repo)
    if (!forge?.listTags) return []
    return forge.listTags(repo.path, { limit: TAG_LIMIT })
  }

  // API index

  const analyzer = () => deps.analyzers?.find((candidate) => candidate.kind === INDEX_KIND)

  const canIndex = async (repo: RepoRef) => {
    const found = analyzer()
    if (!found) return false
    return automaticJobReady(config, store, found, { analyzer: INDEX_KIND, repo })
  }

  /**
   * Newest `api-surface` record id per ref of each repository, read once and then only from the
   * records created since the last read, so waiting batches do not rescan every record.
   */
  const recordIndex = new Map<string, { refs: Map<string, string>; until?: string }>()

  /** Id of the newest `api-surface` record whose ref is one of `refs`. */
  const recordId = async (repo: RepoRef, refs: readonly string[]) => {
    const key = repoKey(repo)
    const index = recordIndex.get(key) ?? { refs: new Map<string, string>() }
    recordIndex.set(key, index)
    const fresh = new Set<string>()
    let before: string | undefined
    let newest: string | undefined
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- pages depend on the previous one
      const heads = await store.analyses.heads({
        repo,
        kind: INDEX_KIND,
        limit: RECORD_PAGE,
        ...(before ? { before } : {}),
        ...(index.until ? { since: index.until } : {}),
      })
      newest ??= heads[0]?.createdAt
      for (const head of heads) {
        if (head.ref === undefined || fresh.has(head.ref)) continue
        fresh.add(head.ref)
        index.refs.set(head.ref, head.id)
      }
      if (heads.length < RECORD_PAGE) break
      before = heads.at(-1)?.createdAt
    }
    if (newest) index.until = newest
    return refs.map((ref) => index.refs.get(ref)).find((id) => id !== undefined)
  }

  const apiOf = async (repo: RepoRef, tag: z.infer<typeof tagSchema>) => {
    const id = await recordId(repo, refsOf(tag))
    const record = id ? await store.analyses.get(id) : undefined
    if (id && !record)
      for (const ref of refsOf(tag)) recordIndex.get(repoKey(repo))?.refs.delete(ref)
    return record ? apiSurfaceDataSchema.safeParse(record.data).data : undefined
  }

  const indexedAll = async (repo: RepoRef, batch: AnnounceBatch) => {
    for (const tag of batch.tags) {
      // oxlint-disable-next-line no-await-in-loop -- a batch has few tags
      if (!(await recordId(repo, refsOf(tag)))) return false
      // oxlint-disable-next-line no-await-in-loop -- see above
      if (tag.previous && !(await recordId(repo, refsOf(tag.previous)))) return false
    }
    return true
  }

  /** Queues `api-surface` for the refs without a record; answers the jobs to wait for. */
  const queueIndexing = async (repo: RepoRef, tags: readonly BatchTag[]) => {
    const refs = [
      ...new Set(
        tags.flatMap((tag) => [tag, ...(tag.previous ? [tag.previous] : [])]).map(releaseTarget),
      ),
    ]
    const jobs: string[] = []
    const active = await store.jobs.list({
      status: ['queued', 'running'],
      repo,
      analyzer: INDEX_KIND,
      limit: 500,
    })
    for (const ref of refs) {
      const tag =
        tags.find((candidate) => releaseTarget(candidate) === ref) ??
        tags.find((candidate) => candidate.previous && releaseTarget(candidate.previous) === ref)
          ?.previous
      // oxlint-disable-next-line no-await-in-loop -- a batch has few tags
      if (await recordId(repo, tag ? refsOf(tag) : [ref])) continue
      const running = active.find((job) => job.ref === ref)
      if (running) {
        jobs.push(running.id)
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      const job = await store.jobs.enqueue({
        analyzer: INDEX_KIND,
        repo,
        ref,
        trigger: 'tag',
        createdAt: nowIso(),
        reason: 'release announcement',
      })
      jobs.push(job.id)
    }
    return jobs
  }

  // Detection

  const schedule = (repo: RepoRef, at: string) => {
    if (!timers) return
    const delay = Math.max(Date.parse(at) - deps.now().getTime(), 0) + 5000
    const timer = setTimeout(() => void serial(repo, () => advanceNow(repo)), delay)
    timer.unref?.()
  }

  /** The version before `tag`, looking deeper than the newest tags when they hold none. */
  const previousOf = async (
    repo: RepoRef,
    settings: ReleaseSettings,
    tag: AnnouncedTag,
    known: { name: string; sha: string }[],
    deep: { tags?: TagRecord[] },
  ) => {
    const found = previousTag(settings, tag, known)
    if (found || known.length < TAG_LIMIT) return found
    deep.tags ??= await forgeOf(repo)
      ?.listTags?.(repo.path, { limit: TAG_LIMIT_DEEP })
      .catch(() => [])
    return deep.tags ? previousTag(settings, tag, deep.tags) : undefined
  }

  /**
   * Records new tags of a repository. The first look records a baseline: every listed tag counts
   * as seen, and on an event the pushed tags stay new. Every listed tag is marked seen, matching
   * or not, so a later, broader `tags` filter does not announce history.
   */
  const noteTags = async (
    repo: RepoRef,
    found: readonly { name: string; sha: string }[],
    source: 'event' | 'poll',
    listed?: TagRecord[],
    known?: ReleaseAnnounceSettings,
  ) => {
    const announce = known ?? (await announceOf(repo))
    if (announce.channels.length === 0) return
    const settings = await flowOf(repo)
    let { state } = await read(repo)
    let tags = listed
    if (!state) {
      tags ??= await listTags(repo)
      const pushed = new Set(source === 'event' ? found.map((tag) => tag.name) : [])
      const seen = tags.map((tag) => tag.name).filter((name) => !pushed.has(name))
      const baseline = await update(repo, (current) =>
        current ? undefined : { baselineAt: nowIso(), seen: seen.slice(0, SEEN_MAX), batches: [] },
      )
      state = baseline.state
      await remember(repo)
      if (source === 'poll') return
      if (!baseline.changed) state = (await reopen(repo, pushed)) ?? state
    }
    const seen = new Set(state?.seen ?? [])
    const candidates = found
      .map((tag) => announcedTag(settings, announce, tag))
      .filter((tag): tag is AnnouncedTag => tag !== undefined && !seen.has(tag.name))
    const unmatched = (listed ?? [])
      .map((tag) => tag.name)
      .filter((name) => !seen.has(name) && !candidates.some((tag) => tag.name === name))
    if (candidates.length === 0) {
      if (unmatched.length) await markSeen(repo, unmatched)
      return
    }
    tags ??= await listTags(repo).catch(() => [])
    const all = [...tags, ...found.filter((tag) => !tags?.some((t) => t.name === tag.name))]
    const deep: { tags?: TagRecord[] } = {}
    const withPrevious: BatchTag[] = []
    for (const candidate of candidates) {
      const sha = tags.find((tag) => tag.name === candidate.name)?.sha ?? candidate.sha
      const tag = { ...candidate, sha }
      // oxlint-disable-next-line no-await-in-loop -- a deeper listing only once, then cached
      const previous = await previousOf(repo, settings, tag, all, deep)
      withPrevious.push({ ...plainTag(tag), ...(previous && { previous: plainTag(previous) }) })
    }
    const indexing = announce.impact && (await canIndex(repo))
    const windowMs = announce.groupWindowMinutes * 60_000
    const now = deps.now()
    let added: { batch: string; closesAt: string; tags: BatchTag[] } | undefined
    await update(repo, (current) => {
      added = undefined
      if (!current) return undefined
      const handled = new Set(current.seen)
      const fresh = withPrevious.filter((tag) => !handled.has(tag.name))
      const others = unmatched.filter((name) => !handled.has(name))
      if (fresh.length === 0 && others.length === 0) return undefined
      current.seen = [...current.seen, ...others, ...fresh.map((tag) => tag.name)].slice(-SEEN_MAX)
      if (fresh.length === 0) return current
      let open = current.batches.find(
        (batch) => batch.status === 'collecting' && now.getTime() < Date.parse(batch.closesAt),
      )
      if (!open) {
        open = {
          id: randomUUID(),
          openedAt: now.toISOString(),
          closesAt: new Date(now.getTime() + windowMs).toISOString(),
          tags: [],
          jobs: [],
          indexing,
          queuedFor: [],
          status: 'collecting',
          attempts: 0,
          posts: [],
        }
        current.batches.push(open)
      }
      open.indexing ||= indexing
      open.tags.push(...fresh)
      added = { batch: open.id, closesAt: open.closesAt, tags: fresh }
      return current
    })
    if (!added) return
    const { batch, closesAt, tags: fresh } = added
    const jobs = indexing ? await queueIndexing(repo, fresh) : []
    await update(repo, (current) => {
      const open = current?.batches.find((candidate) => candidate.id === batch)
      if (!current || !open) return undefined
      open.jobs = [...new Set([...open.jobs, ...jobs])]
      open.queuedFor = [...new Set([...open.queuedFor, ...fresh.map((tag) => tag.name)])]
      return current
    })
    schedule(repo, closesAt)
  }

  /** Marks tags seen without announcing them. */
  const markSeen = (repo: RepoRef, names: readonly string[]) =>
    update(repo, (current) => {
      if (!current) return undefined
      const handled = new Set(current.seen)
      const fresh = names.filter((name) => !handled.has(name))
      if (fresh.length === 0) return undefined
      return { ...current, seen: [...current.seen, ...fresh].slice(-SEEN_MAX) }
    })

  /**
   * After an event lost the baseline to a poll that just listed its tag, the tag is new again
   * unless a batch already holds it.
   */
  const reopen = async (repo: RepoRef, pushed: ReadonlySet<string>) =>
    (
      await update(repo, (current) => {
        if (!current) return undefined
        if (deps.now().getTime() - Date.parse(current.baselineAt) > BASELINE_RACE_MS)
          return undefined
        const batched = new Set(current.batches.flatMap((batch) => batch.tags.map((t) => t.name)))
        const back = [...pushed].filter((name) => current.seen.includes(name) && !batched.has(name))
        if (back.length === 0) return undefined
        return { ...current, seen: current.seen.filter((name) => !back.includes(name)) }
      })
    ).state

  // Posting

  const posterFor = async () => {
    const connection = await slackConnection(deps)
    if (!connection) return undefined
    return (
      deps.slackPoster?.(connection.botToken) ?? slackWebPoster({ token: connection.botToken, log })
    )
  }

  const fileUrl = (origin: RepoRef, ref: string, file: string, line: number) => {
    const forge = config.forges[origin.forge]
    if (!forge) return undefined
    const base = `${forge.url.replace(/\/+$/u, '')}/${origin.path}`
    const path = `${encodeURIComponent(ref)}/${file.split('/').map(encodeURIComponent).join('/')}`
    return forge.kind === 'github'
      ? `${base}/blob/${path}#L${line}`
      : `${base}/-/blob/${path}#L${line}`
  }

  const repoUrl = (origin: RepoRef) => {
    const forge = config.forges[origin.forge]
    return forge ? `${forge.url.replace(/\/+$/u, '')}/${origin.path}` : undefined
  }

  /** What the channel may learn about other teams' repositories (`access.crossTeam`). */
  interface Reach {
    policy: Awaited<ReturnType<typeof crossTeamPolicy>>
    groups: string[]
  }

  /**
   * The repositories the breaking changes of `name` break, from their newest usage records, and
   * how many of them the channel may not name.
   */
  const impactFor = async (
    repo: RepoRef,
    name: string,
    before: ApiPackage,
    changes: ApiChange[],
    version: string,
    several: boolean,
    reach: Reach,
  ): Promise<{ affected: AffectedRepository[]; hidden: number; noUsageData: boolean }> => {
    const filter = usageFilter(repo)
    const noUsageData = (await usages.records(filter)).length === 0
    const impact = await impactOfChanges(usages, filter, name, {
      before,
      changes,
      target: version,
    })
    const byOrigin = new Map<
      string,
      AffectedRepository & { sites: { file: string; line: number }[] }
    >()
    for (const item of impact.items) {
      if (item.level !== 'breaking') continue
      for (const use of item.repos) {
        const origin = originRepo(use.origin)
        const entry = byOrigin.get(use.origin) ?? {
          repo: { label: origin.path, ...(repoUrl(origin) && { url: repoUrl(origin) }) },
          versions: use.versions,
          uses: 0,
          exports: [],
          files: [],
          sites: [],
        }
        entry.uses += use.count
        const exported = use.via ?? item.change.name
        const label = several ? `${name}:${exported}` : exported
        if (!entry.exports.includes(label)) entry.exports.push(label)
        entry.sites.push(...use.sites.map((site) => ({ file: site.file, line: site.line })))
        byOrigin.set(use.origin, entry)
      }
    }
    const affected: AffectedRepository[] = []
    let hidden = 0
    for (const [origin, entry] of byOrigin) {
      const own = sameTeam(reach.groups, repoTarget(config, originRepo(origin)).groups ?? [])
      if (!own && reach.policy === 'off') {
        hidden++
        continue
      }
      if (!own && reach.policy === 'metadata') {
        const { sites: _sites, ...rest } = entry
        affected.push({ ...rest, files: [] })
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- one record per affected repository
      const record = await usages.record(filter, origin)
      const ref = record?.ref ?? 'HEAD'
      const files = [...new Map(entry.sites.map((site) => [site.file, site])).values()]
        .slice(0, 3)
        .map((site) => {
          const url = fileUrl(originRepo(origin), ref, site.file, site.line)
          return { label: `${site.file}:${site.line}`, ...(url && { url }) }
        })
      const { sites: _sites, ...rest } = entry
      affected.push({ ...rest, files })
    }
    return {
      affected: affected.toSorted(
        (a, b) => b.uses - a.uses || a.repo.label.localeCompare(b.repo.label),
      ),
      hidden,
      noUsageData,
    }
  }

  /** The packages a tag released, their API diff to the previous version and its impact. */
  const apiChangesOf = async (repo: RepoRef, tag: BatchTag, reach: Reach) => {
    const now = await apiOf(repo, tag)
    const before = tag.previous ? await apiOf(repo, tag.previous) : undefined
    if (!now) return undefined
    const goReleased = now.packages.filter(
      (pkg) =>
        pkg.ecosystem === 'Go' &&
        bare(pkg.version) === bare(tag.version) &&
        (!tag.package || pkg.dir === tag.package || pkg.dir.startsWith(`${tag.package}/`)),
    )
    const names =
      tag.package && now.packages.some((pkg) => pkg.name === tag.package)
        ? [tag.package]
        : goReleased.length
          ? goReleased.map((pkg) => pkg.name)
          : tag.package
            ? [tag.package]
            : (() => {
                const matching = now.packages.filter((pkg) => pkg.version === tag.version)
                return (
                  matching.length ? matching : now.packages.length === 1 ? now.packages : []
                ).map((pkg) => pkg.name)
              })()
    const packages: {
      name: string
      breaking: ApiChange[]
      impact?: Awaited<ReturnType<typeof impactFor>>
    }[] = []
    for (const name of names) {
      const after = now.packages.find((pkg) => pkg.name === name)
      const old = before?.packages.find(
        (pkg: ApiSurfaceData['packages'][number]) => pkg.name === name,
      )
      if (!after || !old) continue
      const diff = diffPackage(old, after)
      const breaking = breakingApiChanges(diff.changes)
      if (breaking.length === 0) {
        packages.push({ name, breaking })
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- a tag releases few packages
      const impact = await impactFor(
        repo,
        name,
        old,
        diff.changes,
        tag.version,
        names.length > 1,
        reach,
      )
      packages.push({ name, breaking, impact })
    }
    return packages
  }

  const notesFor = async (
    repo: RepoRef,
    announce: ReleaseAnnounceSettings,
    packages: AnnouncementNotesPackage[],
  ): Promise<AnnouncementNotes | undefined> => {
    try {
      const agent = await deps.automaticAgentFor?.(repo, AGENT_ACTOR)
      if (!agent) return undefined
      return await writeAnnouncementNotes(agent, {
        packages,
        language: await languageOf(repo, announce),
      })
    } catch (error) {
      log(`release announcements: notes of ${repoKey(repo)} left out: ${messageOf(error)}`)
      return undefined
    }
  }

  type Mode = 'included' | 'pending' | 'none' | 'unavailable'

  /** The API changes of a tag; a failure leaves this tag without impact instead of the batch. */
  const safeApiChanges = async (repo: RepoRef, tag: BatchTag, reach: Reach) => {
    try {
      return await apiChangesOf(repo, tag, reach)
    } catch (error) {
      log(`release announcements: impact of ${tag.name} left out: ${messageOf(error)}`)
      return undefined
    }
  }

  /** The message of a batch; with `included` the impact from the API index. */
  const compose = async (repo: RepoRef, batch: AnnounceBatch, mode: Mode) => {
    const settings = await flowOf(repo)
    const announce = await announceOf(repo)
    const forge = forgeOf(repo)
    const repository = await forge?.getRepository(repo.path).catch(() => undefined)
    const links =
      forge && repository
        ? forgeLinks({
            kind: forge.kind === 'github' ? 'github' : 'gitlab',
            webUrl: repository.webUrl,
            ...(settings.changelog.ticketUrl ? { ticketUrl: settings.changelog.ticketUrl } : {}),
          })
        : undefined
    const reach: Reach = {
      policy: await crossTeamPolicy(store.settings),
      groups: repoTarget(config, repo).groups ?? [],
    }
    const titles = batch.tags.map((tag) => tag.package ?? repo.path)
    const keyOf = (title: string, version: string) =>
      titles.filter((other) => other === title).length > 1 ? `${title} ${version}` : title
    const prepared: {
      tag: BatchTag
      title: string
      key: string
      entries: ReleaseEntry[]
      tasks: { key: string; titles: string[]; url?: string }[]
      api?: Awaited<ReturnType<typeof apiChangesOf>>
    }[] = []
    for (const tag of batch.tags) {
      const range = forge
        ? // oxlint-disable-next-line no-await-in-loop -- a batch has few tags
          await rangeChanges({
            forge,
            repo,
            settings,
            ...(tag.previous ? { from: tag.previous.name } : {}),
            to: tag.name,
            ...(kv ? { cache: kv } : {}),
            ...(links ? { links } : {}),
          }).catch((error: unknown) => {
            log(`release announcements: changes of ${tag.name} unreadable: ${messageOf(error)}`)
            return undefined
          })
        : undefined
      const title = tag.package ?? repo.path
      const all = range?.entries ?? []
      const entries = tag.package ? packageEntries(all, tag.package) : all
      const tickets = new Set(entries.flatMap((entry) => entry.tickets))
      const tasks = range?.tasks ?? []
      prepared.push({
        tag,
        title,
        key: keyOf(title, tag.version),
        entries,
        tasks:
          entries.length === all.length ? tasks : tasks.filter((task) => tickets.has(task.key)),
        // oxlint-disable-next-line no-await-in-loop -- see above
        ...(mode === 'included' && { api: await safeApiChanges(repo, tag, reach) }),
      })
    }
    let notes = batch.notes
    const askNotes = notes === undefined && announce.notes && !batch.notesTried
    if (askNotes) {
      notes = await notesFor(
        repo,
        announce,
        prepared.map((item) => ({
          name: item.key,
          version: item.tag.version,
          ...(item.tag.previous && { previous: item.tag.previous.version }),
          entries: item.entries,
          apiBreaking: (item.api ?? []).flatMap((pkg) =>
            pkg.breaking.map((change) => ({
              name: change.name,
              change: change.change,
              ...(change.before !== undefined && { before: change.before }),
              ...(change.after !== undefined && { after: change.after }),
            })),
          ),
        })),
      )
    }
    const versions: AnnouncedVersion[] = prepared.map((item) => {
      const note = notes?.find((entry) => entry.name === item.key)
      const fromCommits = breakingEntries(item.entries).map((entry) => ({ change: entry.text }))
      const fromApi = (item.api ?? []).flatMap((pkg) =>
        pkg.breaking.map((change) => ({
          name: change.name,
          change: `${item.api && item.api.length > 1 ? `${pkg.name}: ` : ''}${describeApiChange(change)}`,
        })),
      )
      const breaking = note?.breaking.length
        ? [
            ...note.breaking,
            ...fromApi
              .filter((api) => !note.breaking.some((said) => mentions(said.change, api.name)))
              .map((api) => ({ change: api.change })),
          ]
        : [...fromCommits, ...fromApi.map((api) => ({ change: api.change }))]
      const affectedPackages = (item.api ?? []).filter((pkg) => pkg.impact !== undefined)
      const impact: AnnouncementImpact | undefined =
        announce.impact && affectedPackages.length
          ? {
              affected: mergeAffected(
                affectedPackages.flatMap((pkg) => pkg.impact?.affected ?? []),
              ),
              ...(affectedPackages.some((pkg) => pkg.impact?.hidden) && {
                hidden: affectedPackages.reduce((sum, pkg) => sum + (pkg.impact?.hidden ?? 0), 0),
              }),
              ...(affectedPackages.every((pkg) => pkg.impact?.noUsageData) && {
                noUsageData: true,
              }),
            }
          : undefined
      const sections = sectionOrder.flatMap((id) => {
        const inSection = item.entries.filter((entry) => entry.included && entry.section === id)
        if (inSection.length === 0) return []
        return [
          {
            title: sectionTitles[id],
            items: inSection.map((entry) => {
              const mergeRequest = entry.mergeRequests[0]
              const commit = entry.commits[0]
              const url =
                links && mergeRequest !== undefined
                  ? links.mergeRequest(mergeRequest)
                  : links && commit
                    ? links.commit(commit.sha)
                    : undefined
              return { label: entry.text, ...(url && { url }) }
            }),
          },
        ]
      })
      return {
        title: item.title,
        version: item.tag.version,
        ...(item.tag.previous && { previous: item.tag.previous.version }),
        ...(links &&
          item.tag.previous && {
            compareUrl: links.compare(item.tag.previous.name, item.tag.name),
          }),
        ...(note?.overview && { overview: note.overview }),
        ...(note?.highlights.length && { highlights: note.highlights }),
        ...(breaking.length && { breaking }),
        sections,
        ...(announce.tasks &&
          item.tasks.length && {
            tasks: item.tasks.map((task) => ({
              label: [task.key, task.titles[0]].filter(Boolean).join(' '),
              ...(task.url && { url: task.url }),
            })),
          }),
        ...(impact && { impact }),
      }
    })
    const base = config.server?.publicUrl
    const content: AnnouncementContent = {
      repo: repo.path,
      versions,
      ...(mode === 'pending' && { impactPending: true }),
      ...(mode === 'unavailable' && { impactUnavailable: true }),
      ...(base && { releaseUrl: webUrl(base, webPaths.releaseTimeline(repoKey(repo))) }),
    }
    return {
      message: announcementMessage(content),
      notes,
      notesTried: askNotes,
      channels: announce.channels,
    }
  }

  /**
   * Posts a batch once: the claim moves it from `collecting` to `posting` atomically. When Slack
   * accepted it nowhere it goes back to `collecting` with a later `retryAt`, for a day.
   */
  const post = async (repo: RepoRef, batchId: string, wanted: Exclude<Mode, 'unavailable'>) => {
    const claimed = await update(repo, (current) => {
      const batch = current?.batches.find((candidate) => candidate.id === batchId)
      if (!current || batch?.status !== 'collecting') return undefined
      batch.status = 'posting'
      batch.claimedAt = nowIso()
      return current
    })
    const batch = claimed.state?.batches.find((candidate) => candidate.id === batchId)
    if (!claimed.changed || !batch) return
    const mode = wanted === 'included' && !(await indexedAll(repo, batch)) ? 'pending' : wanted
    let posts: { channel: string; ts: string }[] = []
    let errors: string[] = []
    let notes: AnnouncementNotes | undefined
    let notesTried = false
    try {
      const poster = await posterFor()
      if (!poster) errors = ['no Slack credential']
      else {
        const composed = await compose(repo, batch, mode)
        notes = composed.notes
        notesTried = composed.notesTried
        ;({ posts, errors } = await postAll(poster, composed.channels, composed.message))
      }
    } catch (error) {
      errors = [messageOf(error)]
    }
    const now = deps.now().getTime()
    const final = errors.length > 0 && errors.every((error) => FINAL_ERRORS.has(error))
    const retry = posts.length === 0 && !final && now - Date.parse(batch.openedAt) < RETRY_FOR_MS
    if (errors.length)
      log(
        `release announcements: ${repoKey(repo)} ${posts.length ? 'partly posted' : retry ? 'not posted yet' : 'not announced'}: ${errors.join(', ')}`,
      )
    let retryAt: string | undefined
    await update(repo, (current) => {
      const done = current?.batches.find((candidate) => candidate.id === batchId)
      if (!current || !done) return undefined
      delete done.claimedAt
      if (notes) done.notes = notes
      if (notesTried) done.notesTried = true
      if (retry) {
        done.status = 'collecting'
        done.attempts += 1
        retryAt = new Date(now + retryDelayMs(done.attempts)).toISOString()
        done.retryAt = retryAt
        return current
      }
      done.status = 'posted'
      done.posts = posts
      done.impact = posts.length ? mode : 'none'
      done.postedAt = nowIso()
      delete done.retryAt
      return current
    })
    if (retryAt) schedule(repo, retryAt)
  }

  /**
   * Rewrites the posted messages of a batch with its impact, or as unavailable; once every message
   * took the update, or for good a day after posting.
   */
  const refresh = async (repo: RepoRef, batchId: string, mode: 'included' | 'unavailable') => {
    const claimed = await update(repo, (current) => {
      const batch = current?.batches.find((candidate) => candidate.id === batchId)
      if (!current || batch?.status !== 'posted' || batch.impact !== 'pending') return undefined
      if (batch.updating && deps.now().getTime() - Date.parse(batch.updating) < 10 * 60_000)
        return undefined
      batch.updating = nowIso()
      return current
    })
    const batch = claimed.state?.batches.find((candidate) => candidate.id === batchId)
    if (!claimed.changed || !batch) return
    let done = false
    try {
      const poster = await posterFor()
      if (poster) {
        const { message } = await compose(repo, batch, mode)
        done = true
        for (const target of batch.posts) {
          // oxlint-disable-next-line no-await-in-loop -- one message per channel
          const result = await poster.update({ channel: target.channel, ts: target.ts, ...message })
          if (!result.ok) {
            done = false
            log(`release announcements: updating ${repoKey(repo)} refused: ${result.error ?? '?'}`)
          }
        }
      }
    } catch (error) {
      log(`release announcements: updating ${repoKey(repo)} failed: ${messageOf(error)}`)
    }
    const expired =
      deps.now().getTime() >= Date.parse(batch.postedAt ?? batch.openedAt) + IMPACT_FOLLOW_MS
    await update(repo, (current) => {
      const updated = current?.batches.find((candidate) => candidate.id === batchId)
      if (!current || !updated) return undefined
      delete updated.updating
      if (done) updated.impact = mode === 'included' ? 'included' : 'none'
      else if (expired) updated.impact = 'none'
      return current
    })
  }

  /** Gives up a batch whose posting process died, without posting it twice. */
  const abandon = (repo: RepoRef, batchId: string) =>
    update(repo, (current) => {
      const batch = current?.batches.find((candidate) => candidate.id === batchId)
      if (!current || batch?.status !== 'posting') return undefined
      log(`release announcements: ${repoKey(repo)} batch ${batchId} was left mid-post; given up`)
      batch.status = 'posted'
      batch.impact = 'none'
      batch.postedAt = nowIso()
      delete batch.claimedAt
      return current
    })

  const advanceNow = async (repo: RepoRef) => {
    const { state } = await read(repo)
    if (!state) return
    const now = deps.now().getTime()
    for (const batch of state.batches) {
      if (batch.status === 'posting') {
        if (now - Date.parse(batch.claimedAt ?? batch.openedAt) >= STUCK_MS)
          // oxlint-disable-next-line no-await-in-loop -- batches of one repository in order
          await abandon(repo, batch.id)
        continue
      }
      if (batch.status === 'collecting' && now >= Date.parse(batch.closesAt)) {
        if (batch.retryAt && now < Date.parse(batch.retryAt)) continue
        if (!batch.indexing) {
          // oxlint-disable-next-line no-await-in-loop -- see above
          await post(repo, batch.id, 'none')
          continue
        }
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (await indexedAll(repo, batch)) {
          // oxlint-disable-next-line no-await-in-loop -- see above
          await post(repo, batch.id, 'included')
          continue
        }
        const queued = batch.tags.every((tag) => batch.queuedFor.includes(tag.name))
        // oxlint-disable-next-line no-await-in-loop -- see above
        const jobs = await Promise.all(batch.jobs.map((id) => store.jobs.get(id)))
        const ended = queued && jobs.every((job) => !job || FINAL_JOBS.has(job.status))
        if (ended || now >= Date.parse(batch.openedAt) + ANNOUNCE_INDEX_TIMEOUT_MS)
          // oxlint-disable-next-line no-await-in-loop -- see above
          await post(repo, batch.id, 'pending')
        continue
      }
      if (batch.status === 'posted' && batch.impact === 'pending') {
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (await indexedAll(repo, batch)) await refresh(repo, batch.id, 'included')
        else if (now >= Date.parse(batch.postedAt ?? batch.openedAt) + IMPACT_FOLLOW_MS)
          // oxlint-disable-next-line no-await-in-loop -- see above
          await refresh(repo, batch.id, 'unavailable')
      }
    }
    await update(repo, (current) => {
      if (!current) return undefined
      const finished = current.batches.filter(
        (batch) => batch.status === 'posted' && batch.impact !== 'pending',
      )
      const keep = new Set(
        finished
          .filter((batch) => now - Date.parse(batch.postedAt ?? batch.openedAt) < KEEP_POSTED_MS)
          .slice(-KEEP_POSTED)
          .map((batch) => batch.id),
      )
      const batches = current.batches.filter(
        (batch) => !finished.includes(batch) || keep.has(batch.id),
      )
      if (batches.length === current.batches.length) return undefined
      return { ...current, batches }
    })
  }

  /** Runs `work` after earlier work of the same repository in this process. */
  const serial = (repo: RepoRef, work: () => Promise<void>) => {
    const key = repoKey(repo)
    const run = (chains.get(key) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      log(`release announcements: ${key}: ${messageOf(error)}`)
    })
    chains.set(key, run)
    void run.finally(() => {
      if (chains.get(key) === run) chains.delete(key)
    })
    return run
  }

  const pollNow = async (repo: RepoRef, announce?: ReleaseAnnounceSettings) => {
    const listed = await listTags(repo)
    await noteTags(repo, listed, 'poll', listed, announce)
    await update(repo, (current) => (current ? { ...current, polledAt: nowIso() } : undefined))
  }

  return {
    onTag: (repo, tag) =>
      kv
        ? serial(repo, async () => {
            await noteTags(repo, [tag], 'event')
            await advanceNow(repo)
          })
        : Promise.resolve(),

    indexFinished: (job) =>
      kv && job.analyzer === INDEX_KIND
        ? serial(job.repo, () => advanceNow(job.repo))
        : Promise.resolve(),

    poll: (repo) => (kv ? serial(repo, () => pollNow(repo)) : Promise.resolve()),

    advance: (repo) => (kv ? serial(repo, () => advanceNow(repo)) : Promise.resolve()),

    stateOf: async (repo) => (await read(repo)).state,

    sweep: async () => {
      if (!kv) return
      const covered = new Map<string, RepoRef>()
      const known = await indexed()
      for (const repo of [...(await listedRepos(kv, config)), ...known])
        covered.set(repoKey(repo), repo)
      const entries = await store.settings.list(releaseAnnounceSettingKey)
      for (const repo of covered.values()) {
        // oxlint-disable-next-line no-await-in-loop -- repositories one at a time, few forge calls
        await serial(repo, async () => {
          const announce = await announceOf(repo, entries)
          const { state } = await read(repo)
          if (announce.channels.length === 0) {
            if (state || known.some((entry) => repoKey(entry) === repoKey(repo))) await forget(repo)
            return
          }
          const polledAt = state?.polledAt ?? (state ? state.baselineAt : undefined)
          if (!polledAt || deps.now().getTime() - Date.parse(polledAt) >= POLL_MS)
            await pollNow(repo, announce)
          await advanceNow(repo)
        })
      }
    },
  }
}

/** Affected repositories of several packages of one tag, one entry per repository. */
function mergeAffected(entries: readonly AffectedRepository[]): AffectedRepository[] {
  const merged = new Map<string, AffectedRepository>()
  for (const entry of entries) {
    const known = merged.get(entry.repo.label)
    if (!known) {
      merged.set(entry.repo.label, structuredClone(entry))
      continue
    }
    known.uses += entry.uses
    known.exports.push(...entry.exports.filter((name) => !known.exports.includes(name)))
    known.versions.push(...entry.versions.filter((version) => !known.versions.includes(version)))
    known.files.push(...entry.files)
    known.files = known.files.slice(0, 3)
  }
  return [...merged.values()].toSorted((a, b) => b.uses - a.uses)
}

const announcers = new WeakMap<ServerDeps, ReleaseAnnouncer>()

/** The one release announcer of a server; the options of the first call win. */
export function releaseAnnouncerFor(
  deps: ServerDeps,
  options?: ReleaseAnnouncerOptions,
): ReleaseAnnouncer {
  let announcer = announcers.get(deps)
  if (!announcer) {
    announcer = createReleaseAnnouncer(deps, options)
    announcers.set(deps, announcer)
  }
  return announcer
}
