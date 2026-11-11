import { ticketKeys } from '@holtkeeper/commit-conventions'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import type { Issue } from '@holtkeeper/issues'
import { z } from 'zod'

import { parseCommit } from './conventional.ts'
import { UnsupportedForgeError, commitCap, toReleaseCommit } from './facts.ts'
import type { ChangelogLinks } from './links.ts'
import { buildEntries, renderChangelog, suggestBump } from './notes.ts'
import type { Bump, ReleaseSettings } from './settings.ts'
import type { ReleaseCommit, ReleaseEntry } from './types.ts'
import type { VersionTag } from './version.ts'

/** Where ranges between immutable commits are kept; `Store.kv` fits. Entries never expire. */
export interface RangeCache {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

/** Commits of one range, newest first, at most `commitCap`. */
export interface ReleaseRange {
  commits: ReleaseCommit[]
  capped: boolean
}

const rangeSchema = z.object({
  commits: z.array(
    z.object({
      sha: z.string(),
      parents: z.array(z.string()),
      author: z.object({ name: z.string(), email: z.string() }),
      date: z.string(),
      subject: z.string(),
      body: z.string(),
    }),
  ),
  capped: z.boolean(),
})

const fullSha = /^[0-9a-f]{40}$/u

/** Cache key of the range `from..to` (`root` when `from` is absent) of a repository. */
export const rangeKey = (repo: RepoRef, from: string | undefined, to: string) =>
  `release:range:${repo.forge}:${repo.path}:${from ?? 'root'}:${to}`

export interface CollectRangeOptions {
  forge: GitForge
  repo: RepoRef
  /** Exclusive start: commits reachable from it are left out; absent for the whole history. */
  from?: string
  to: string
  cache?: RangeCache
}

/**
 * Commits reachable from `to` but not from `from`, read with `listCommits({ ref, since })`, no
 * checkout. When both ends are full commit shas (tags of two versions) the range can never change,
 * so it is kept in `cache` for good and read from there next time.
 */
export async function collectRangeFacts({
  forge,
  repo,
  from,
  to,
  cache,
}: CollectRangeOptions): Promise<ReleaseRange> {
  const immutable = fullSha.test(to) && (from === undefined || fullSha.test(from))
  const key = rangeKey(repo, from, to)
  if (immutable && cache) {
    const stored = rangeSchema.safeParse(await cache.get(key).catch(() => undefined))
    if (stored.success) return stored.data
  }
  if (!forge.listCommits) throw new UnsupportedForgeError('list commits')
  const list = await forge.listCommits(repo.path, {
    ref: to,
    ...(from ? { since: from } : {}),
    limit: commitCap + 1,
  })
  const range = {
    commits: list.slice(0, commitCap).map(toReleaseCommit),
    capped: list.length > commitCap,
  }
  if (immutable && cache) await cache.set(key, range).catch(() => {})
  return range
}

/** A tracker key and what the commits of a range say about it. */
export interface ReleaseTask {
  key: string
  /** Distinct commit or merge request titles that name the key, newest first, at most five. */
  titles: string[]
  commits: number
  url?: string
  /** What the tracker says about it, when one is connected. */
  issue?: Issue
}

/**
 * Tasks of a range: tracker keys (`ABC-123`) found in commit subjects and bodies, so squash
 * commits, merge commits (merge request titles and branch names) and plain commits all count.
 * Ordered by the newest commit that names them.
 */
export function releaseTasks(
  commits: readonly ReleaseCommit[],
  links?: ChangelogLinks,
): ReleaseTask[] {
  const tasks = new Map<string, ReleaseTask>()
  for (const commit of commits) {
    const keys = new Set(ticketKeys(`${commit.subject}\n${commit.body}`))
    if (keys.size === 0) continue
    const title = parseCommit(commit.subject, commit.body).description
    for (const key of keys) {
      const url = links?.ticket(key)
      const task = tasks.get(key) ?? { key, titles: [], commits: 0, ...(url ? { url } : {}) }
      task.commits += 1
      if (title && !task.titles.includes(title) && task.titles.length < 5) task.titles.push(title)
      tasks.set(key, task)
    }
  }
  return [...tasks.values()]
}

/** `tasks` with the tracker's issue of each key that has one; the issue's page wins as `url`. */
export function withIssues(
  tasks: readonly ReleaseTask[],
  issues: Readonly<Record<string, Issue>>,
): ReleaseTask[] {
  return tasks.map((task) => {
    const issue = issues[task.key]
    if (!issue) return task
    const url = issue.url ?? task.url
    return { ...task, issue, ...(url ? { url } : {}) }
  })
}

/** What changed in one range of commits. */
export interface RangeChanges {
  commitCount: number
  /** More than `commitCap` commits; counts are a floor. */
  capped: boolean
  entries: ReleaseEntry[]
  /** Markdown of the included entries. */
  changelog: string
  tasks: ReleaseTask[]
  /** What the changes call for compared with `current`. */
  bump: Bump
}

/**
 * Entries, changelog, tasks and the bump of the commits reachable from `to` but not from `from`
 * (`collectRangeFacts`), with the repository's changelog settings; `current` is the version the
 * bump applies to.
 */
export async function rangeChanges(
  options: CollectRangeOptions & {
    settings: ReleaseSettings
    links?: ChangelogLinks
    current?: string
  },
): Promise<RangeChanges> {
  const range = await collectRangeFacts(options)
  const entries = buildEntries(range.commits, options.settings.changelog)
  return {
    commitCount: range.commits.length,
    capped: range.capped,
    entries,
    changelog: renderChangelog(entries, options.links),
    tasks: releaseTasks(range.commits, options.links),
    bump: suggestBump(entries, options.current ? { current: options.current } : {}).bump,
  }
}

/** One past version on the timeline. */
export interface ReleaseVersion {
  tag: string
  version: string
  sha: string
  date?: string
  /** Tag of the version before it; absent for the oldest one. */
  previous?: string
  commitCount: number
  /** More than `commitCap` commits; counts are a floor. */
  capped: boolean
  /** Tracker keys of its tasks. */
  tickets: string[]
  /** What its changes called for compared with the previous version. */
  bump: Bump
}

/** Everything one version holds. */
export interface ReleaseVersionDetail extends ReleaseVersion {
  entries: ReleaseEntry[]
  /** Markdown of the included entries, as on the forge release. */
  changelog: string
  tasks: ReleaseTask[]
  compareUrl?: string
}

/** The versions a timeline shows: release candidates only when the settings make them. */
export const timelineVersions = (settings: ReleaseSettings, versions: readonly VersionTag[]) =>
  settings.version.prerelease ? [...versions] : versions.filter((tag) => !tag.version.includes('-'))

export interface VersionOptions {
  forge: GitForge
  repo: RepoRef
  settings: ReleaseSettings
  /** Version tags, newest first (`versionTags`). */
  versions: readonly VersionTag[]
  /**
   * `false` when `versions` came from a capped tag list, so the version before the oldest one is
   * unknown: the oldest serves only as the start of the range of the next one and is not shown.
   */
  complete?: boolean
  cache?: RangeCache
  links?: ChangelogLinks
}

const detailAt = async (
  options: VersionOptions,
  shown: readonly VersionTag[],
  index: number,
): Promise<ReleaseVersionDetail> => {
  const tag = shown[index]!
  const previous = shown[index + 1]
  const changes = await rangeChanges({
    forge: options.forge,
    repo: options.repo,
    settings: options.settings,
    ...(previous ? { from: previous.sha, current: previous.version } : {}),
    to: tag.sha,
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.links ? { links: options.links } : {}),
  })
  const compareUrl = previous && options.links?.compare(previous.tag, tag.tag)
  return {
    tag: tag.tag,
    version: tag.version,
    sha: tag.sha,
    ...(tag.date ? { date: tag.date } : {}),
    ...(previous ? { previous: previous.tag } : {}),
    commitCount: changes.commitCount,
    capped: changes.capped,
    tickets: changes.tasks.map((task) => task.key),
    bump: changes.bump,
    entries: changes.entries,
    changelog: changes.changelog,
    tasks: changes.tasks,
    ...(compareUrl ? { compareUrl } : {}),
  }
}

const describable = (options: VersionOptions, list: readonly VersionTag[]) =>
  options.complete === false ? list.slice(0, -1) : list

/**
 * One page of past versions, newest first: each with its commit count, task keys and bump
 * against the version before it. Ranges between two version tags come from the permanent
 * cache after the first read. `nextOffset` is set while older versions remain.
 */
export async function versionTimeline(
  options: VersionOptions & { offset?: number; limit?: number },
): Promise<{ versions: ReleaseVersion[]; total: number; nextOffset?: number }> {
  const all = timelineVersions(options.settings, options.versions)
  const shown = describable(options, all)
  const offset = Math.max(0, options.offset ?? 0)
  const limit = Math.max(1, options.limit ?? 10)
  const page = shown.slice(offset, offset + limit)
  const details = await Promise.all(page.map((_, at) => detailAt(options, all, offset + at)))
  const versions = details.map(
    ({ entries: _entries, changelog: _changelog, tasks: _tasks, compareUrl: _url, ...rest }) =>
      rest,
  )
  const next = offset + page.length
  return { versions, total: shown.length, ...(next < shown.length ? { nextOffset: next } : {}) }
}

/** One version in full: entries, changelog, tasks and the compare link; `undefined` when unknown. */
export async function versionDetail(
  options: VersionOptions & { tag: string },
): Promise<ReleaseVersionDetail | undefined> {
  const shown = timelineVersions(options.settings, options.versions)
  const index = describable(options, shown).findIndex((tag) => tag.tag === options.tag)
  if (index !== -1) return detailAt(options, shown, index)
  const tag = options.versions.find((candidate) => candidate.tag === options.tag)
  if (!tag) return undefined
  const own = new Set([tag, ...shown])
  const sorted = options.versions.filter((candidate) => own.has(candidate))
  const at = sorted.indexOf(tag)
  return at < describable(options, sorted).length ? detailAt(options, sorted, at) : undefined
}
