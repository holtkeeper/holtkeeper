import type {
  LibraryIssue,
  LibraryRecord,
  LibraryRepository,
  LibrarySourceStatus,
  LibraryStore,
} from '@holtkeeper/store'

import type { GitHubClient, GitHubResponse } from '../github/client.ts'
import { GitHubRateLimitError } from '../github/client.ts'
import {
  type FetchedIssue,
  type RestIssue,
  cleanBody,
  fixedInText,
  fromRest,
  hasBugLabel,
  issueId,
  versionOfMilestone,
} from './shared.ts'

export interface IndexIssuesInput {
  store: LibraryStore
  github: GitHubClient
  library: LibraryRecord
  /** Release date of the oldest version any repository uses; the window starts six months before it. */
  oldestUsedReleaseAt?: string
  now: Date
  /** Threads kept per run. Default 400. */
  maxIssues?: number
  /** Reactions that keep a thread without a fix or a bug label. Default 5. */
  minReactions?: number
  /** Listing pages read per run and stream (100 issues per REST page, 50 per GraphQL page). Default 10. */
  maxPages?: number
  signal?: AbortSignal
  log?: (message: string) => void
}

export interface IndexIssuesResult {
  status: LibrarySourceStatus['status']
  /** Threads stored by this run. */
  stored: number
  /** Threads read from GitHub, kept or not. */
  scanned: number
  message?: string
}

interface Cursor {
  /** Newest `updatedAt` of issues read so far; listing resumes there. */
  issues?: string
  /** Newest `updatedAt` of discussions read so far. */
  discussions?: string
}

const OVERLAP_MS = 60_000
const MAINTAINERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const OTHER_PACKAGE_LABEL = /^(?:pkg|package|packages|scope|area|module)\s*[:/]/i

const parseCursor = (raw: string | undefined): Cursor => {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return {}
    const issues: unknown = Reflect.get(value, 'issues')
    const discussions: unknown = Reflect.get(value, 'discussions')
    return {
      ...(typeof issues === 'string' ? { issues } : {}),
      ...(typeof discussions === 'string' ? { discussions } : {}),
    }
  } catch {
    return {}
  }
}

const later = (a: string | undefined, b: string | undefined) =>
  a === undefined ? b : b === undefined ? a : a > b ? a : b

/** Start of the indexed window: six months before the oldest used release, else two years back. */
export function issueWindowStart(now: Date, oldestUsedReleaseAt?: string): string {
  const oldest = oldestUsedReleaseAt ? new Date(oldestUsedReleaseAt) : undefined
  if (oldest && Number.isFinite(oldest.getTime())) {
    oldest.setUTCMonth(oldest.getUTCMonth() - 6)
    return oldest.toISOString()
  }
  const start = new Date(now.getTime())
  start.setUTCFullYear(start.getUTCFullYear() - 2)
  return start.toISOString()
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

/**
 * Names a thread of a monorepo uses for the package: the package name, its scoped form with the
 * slash as a dash (`@babel/core` → `babel-core`) and the last segment of the package folder.
 */
export function packageTokens(name: string, directory: string | undefined): string[] {
  const tokens = new Set([name.toLowerCase()])
  if (name.startsWith('@')) tokens.add(name.slice(1).replace('/', '-').toLowerCase())
  const folder = directory?.split('/').at(-1)?.toLowerCase()
  if (folder && folder.length >= 3) tokens.add(folder)
  return [...tokens]
}

/** `match`: title or labels name the package; `other`: a package-scoped label names another one. */
export function packageRelevance(
  thread: Pick<FetchedIssue, 'title' | 'labels'>,
  tokens: readonly string[],
): 'match' | 'other' | 'neutral' {
  const patterns = tokens.map(
    (token) => new RegExp(`(?:^|[^\\w-])${escapeRegExp(token)}(?![\\w-])`, 'i'),
  )
  const mentions = (text: string) => patterns.some((pattern) => pattern.test(text))
  if (mentions(thread.title) || thread.labels.some(mentions)) return 'match'
  return thread.labels.some((label) => OTHER_PACKAGE_LABEL.test(label)) ? 'other' : 'neutral'
}

/** Whether a fetched thread is worth indexing: a fix, a bug label, enough reactions or an answer. */
export function keepThread(thread: FetchedIssue, minReactions: number): boolean {
  if (thread.kind === 'discussion') return thread.answer !== undefined
  return thread.pulls.length > 0 || hasBugLabel(thread.labels) || thread.reactions >= minReactions
}

interface GraphComment {
  authorAssociation?: string
  body?: string
}
interface GraphPull {
  number?: number
  merged?: boolean
  milestone?: { title?: string } | null
  repository?: { nameWithOwner?: string }
}
interface GraphIssue {
  number: number
  title: string
  url: string
  state: string
  stateReason?: string | null
  body?: string | null
  createdAt: string
  updatedAt: string
  closedAt?: string | null
  milestone?: { title?: string } | null
  labels?: { nodes?: ({ name?: string } | null)[] }
  reactions?: { totalCount?: number }
  comments?: { totalCount?: number; nodes?: (GraphComment | null)[] }
  closedByPullRequestsReferences?: { nodes?: (GraphPull | null)[] }
  timelineItems?: {
    nodes?: ({ source?: GraphPull | null; closer?: (GraphPull & { oid?: string }) | null } | null)[]
  }
}
interface GraphDiscussion {
  number: number
  title: string
  url: string
  closed?: boolean
  body?: string | null
  createdAt: string
  updatedAt: string
  closedAt?: string | null
  labels?: { nodes?: ({ name?: string } | null)[] }
  reactions?: { totalCount?: number }
  comments?: { totalCount?: number }
  answer?: { body?: string | null } | null
}
interface Page<T> {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  nodes?: (T | null)[]
}

const ISSUES_QUERY = `query($owner: String!, $name: String!, $since: DateTime!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $after, states: CLOSED, filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url state stateReason body createdAt updatedAt closedAt
        milestone { title }
        labels(first: 20) { nodes { name } }
        reactions { totalCount }
        comments(first: 20) { totalCount nodes { authorAssociation body } }
        closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { number merged milestone { title } } }
        timelineItems(first: 10, itemTypes: [CROSS_REFERENCED_EVENT, CLOSED_EVENT]) {
          nodes {
            ... on CrossReferencedEvent { source { ... on PullRequest { number merged milestone { title } repository { nameWithOwner } } } }
            ... on ClosedEvent { closer { ... on PullRequest { number merged milestone { title } repository { nameWithOwner } } } }
          }
        }
      }
    }
  }
}`

const DISCUSSIONS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 50, after: $after, answered: true, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url closed body createdAt updatedAt closedAt
        labels(first: 20) { nodes { name } }
        reactions { totalCount }
        comments { totalCount }
        answer { body }
      }
    }
  }
}`

const nodesOf = <T>(list: { nodes?: (T | null)[] } | undefined): T[] =>
  (list?.nodes ?? []).filter((node): node is T => node !== null && node !== undefined)

const labelNames = (labels: GraphIssue['labels']) =>
  nodesOf(labels)
    .map((label) => label.name ?? '')
    .filter(Boolean)

function fromGraphIssue(repo: LibraryRepository, node: GraphIssue): FetchedIssue {
  const closing = nodesOf(node.closedByPullRequestsReferences)
  const events = nodesOf(node.timelineItems)
  const sameRepo = (pull: GraphPull) =>
    pull.repository?.nameWithOwner === undefined ||
    pull.repository.nameWithOwner.toLowerCase() === repo.path.toLowerCase()
  const closer = events
    .map((event) => event.closer)
    .filter((pull): pull is GraphPull => typeof pull?.number === 'number' && sameRepo(pull))
  const referenced = events
    .map((event) => event.source)
    .filter(
      (pull): pull is GraphPull =>
        typeof pull?.number === 'number' && pull.merged === true && sameRepo(pull),
    )
  const pullList = [...closing, ...closer, ...referenced]
  const pulls = [
    ...new Set(pullList.map((pull) => pull.number).filter((n): n is number => n !== undefined)),
  ]
  const comments = nodesOf(node.comments)
  const maintainer = comments.filter(
    (comment) => comment.authorAssociation && MAINTAINERS.has(comment.authorAssociation),
  )
  const fixedIn =
    pullList.map((pull) => versionOfMilestone(pull.milestone?.title)).find(Boolean) ??
    versionOfMilestone(node.milestone?.title) ??
    maintainer.map((comment) => fixedInText(comment.body)).find(Boolean)
  const answer = maintainer[0]?.body ? cleanBody(maintainer[0].body) : undefined
  return {
    id: issueId(repo, node.number),
    number: node.number,
    kind: 'issue',
    title: node.title,
    state: node.state === 'CLOSED' ? 'closed' : 'open',
    labels: labelNames(node.labels),
    url: node.url,
    body: cleanBody(node.body),
    ...(answer ? { answer } : {}),
    pulls,
    ...(fixedIn ? { fixedIn } : {}),
    reactions: node.reactions?.totalCount ?? 0,
    comments: node.comments?.totalCount ?? 0,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    ...(node.closedAt ? { closedAt: node.closedAt } : {}),
  }
}

function fromGraphDiscussion(repo: LibraryRepository, node: GraphDiscussion): FetchedIssue {
  const answer = node.answer?.body ? cleanBody(node.answer.body) : undefined
  const fixedIn = fixedInText(node.answer?.body)
  return {
    id: issueId(repo, node.number),
    number: node.number,
    kind: 'discussion',
    title: node.title,
    state: node.closed ? 'closed' : 'open',
    labels: labelNames(node.labels),
    url: node.url,
    body: cleanBody(node.body),
    ...(answer ? { answer } : {}),
    pulls: [],
    ...(fixedIn ? { fixedIn } : {}),
    reactions: node.reactions?.totalCount ?? 0,
    comments: node.comments?.totalCount ?? 0,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    ...(node.closedAt ? { closedAt: node.closedAt } : {}),
  }
}

interface Stream {
  threads: FetchedIssue[]
  scanned: number
  /** Newest `updatedAt` read. */
  newest?: string
  complete: boolean
}

async function graphIssues(
  github: GitHubClient,
  repo: LibraryRepository,
  since: string,
  maxPages: number,
  signal: AbortSignal | undefined,
): Promise<Stream> {
  const [owner, name] = repo.path.split('/')
  const stream: Stream = { threads: [], scanned: 0, complete: false }
  let after: string | null | undefined
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted()
    // oxlint-disable-next-line no-await-in-loop -- pages follow each other's cursors
    const data = await github.graphql<{ repository?: { issues?: Page<GraphIssue> } | null }>(
      ISSUES_QUERY,
      { owner, name, since, after: after ?? null },
    )
    const list = data.repository?.issues
    for (const node of nodesOf(list)) {
      stream.scanned++
      stream.newest = later(stream.newest, node.updatedAt)
      if (node.stateReason === 'DUPLICATE') continue
      stream.threads.push(fromGraphIssue(repo, node))
    }
    after = list?.pageInfo?.endCursor
    if (!list?.pageInfo?.hasNextPage || !after) {
      stream.complete = true
      break
    }
  }
  return stream
}

async function graphDiscussions(
  github: GitHubClient,
  repo: LibraryRepository,
  since: string,
  maxPages: number,
  signal: AbortSignal | undefined,
): Promise<Stream> {
  const [owner, name] = repo.path.split('/')
  const stream: Stream = { threads: [], scanned: 0, complete: false }
  let after: string | null | undefined
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted()
    // oxlint-disable-next-line no-await-in-loop -- pages follow each other's cursors
    const data = await github.graphql<{
      repository?: { discussions?: Page<GraphDiscussion> } | null
    }>(DISCUSSIONS_QUERY, { owner, name, after: after ?? null })
    const list = data.repository?.discussions
    let reachedSince = false
    for (const node of nodesOf(list)) {
      if (node.updatedAt < since) {
        reachedSince = true
        break
      }
      stream.scanned++
      stream.newest = later(stream.newest, node.updatedAt)
      stream.threads.push(fromGraphDiscussion(repo, node))
    }
    after = list?.pageInfo?.endCursor
    if (reachedSince || !list?.pageInfo?.hasNextPage || !after) {
      stream.complete = true
      break
    }
  }
  return stream
}

async function restIssues(
  github: GitHubClient,
  repo: LibraryRepository,
  since: string,
  maxPages: number,
  signal: AbortSignal | undefined,
): Promise<Stream> {
  const stream: Stream = { threads: [], scanned: 0, complete: false }
  let path: string | undefined =
    `/repos/${repo.path}/issues?state=closed&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`
  for (let page = 0; page < maxPages && path; page++) {
    signal?.throwIfAborted()
    // oxlint-disable-next-line no-await-in-loop -- pages follow each other's `next` links
    const response: GitHubResponse<RestIssue[] | undefined> = await github.rest<RestIssue[]>(path)
    for (const item of response.data ?? []) {
      stream.scanned++
      stream.newest = later(stream.newest, item.updated_at)
      if (item.pull_request !== undefined || item.state_reason === 'duplicate') continue
      stream.threads.push(fromRest(repo, item))
    }
    path = response.next
  }
  stream.complete = path === undefined
  return stream
}

/**
 * Indexes closed issues and answered discussions of the library's GitHub repository into the store,
 * incrementally by `updatedAt` from `library.issuesCursor`, and records the new cursor and
 * `sources.issues` on the library. Never throws for GitHub failures: they end up in the status.
 *
 * - Window: threads created since `issueWindowStart` (six months before the oldest used release,
 *   else two years back).
 * - Kept: issues with a closing or merged cross-referencing pull request of the same repository, a
 *   label containing `bug`, `regression` or `breaking`, or at least `minReactions` reactions;
 *   answered discussions. Duplicates are skipped; open issues are left to live search.
 * - With a token (GraphQL): pull requests, the first maintainer comment as `answer`, `fixedIn` from
 *   a version-like milestone or a "fixed in vX" maintainer comment, and discussions. Without one
 *   (REST): labels and reactions only, `fixedIn` from the issue milestone, no discussions.
 * - Monorepos (`repository.directory`): threads whose title or labels name the package come first;
 *   threads whose package-scoped label (`pkg: …`, `area/…`) names something else are dropped;
 *   the remaining neutral threads fill what `maxIssues` leaves.
 * - Issues are listed oldest update first, at most `maxPages` pages per run, and resume from the
 *   cursor, so a large backlog is indexed over several runs. Discussions have no `since` filter:
 *   they are read newest first down to the cursor, and older ones past `maxPages` are skipped.
 *   At most `maxIssues` threads are stored per run; a stored digest survives while the state holds.
 */
export async function indexIssues(input: IndexIssuesInput): Promise<IndexIssuesResult> {
  const { store, github, now, signal } = input
  const maxIssues = input.maxIssues ?? 400
  const minReactions = input.minReactions ?? 5
  const maxPages = input.maxPages ?? 10
  const current = (await store.getLibrary(input.library)) ?? input.library
  const repo = current.repository
  const at = now.toISOString()
  const record = async (status: LibrarySourceStatus, cursor?: Cursor) => {
    await store.putLibrary({
      ...current,
      sources: { ...current.sources, issues: status },
      ...(cursor ? { issuesCursor: JSON.stringify(cursor) } : {}),
      updatedAt: at,
    })
  }

  if (!repo || repo.host !== 'github.com') {
    const message = repo ? `issues are indexed for GitHub only, not ${repo.host}` : 'no repository'
    await record({ status: 'skipped', at, message })
    return { status: 'skipped', stored: 0, scanned: 0, message }
  }

  const windowStart = issueWindowStart(now, input.oldestUsedReleaseAt)
  const cursor = parseCursor(current.issuesCursor)
  const sinceOf = (position: string | undefined) => {
    const resumed = position ? new Date(Date.parse(position) - OVERLAP_MS).toISOString() : undefined
    return resumed && resumed > windowStart ? resumed : windowStart
  }

  const streams: Stream[] = []
  const next: Cursor = { ...cursor }
  let message: string | undefined
  try {
    const issues = github.authenticated
      ? await graphIssues(github, repo, sinceOf(cursor.issues), maxPages, signal)
      : await restIssues(github, repo, sinceOf(cursor.issues), maxPages, signal)
    streams.push(issues)
    next.issues = later(cursor.issues, issues.newest)
    if (github.authenticated) {
      const discussions = await graphDiscussions(
        github,
        repo,
        sinceOf(cursor.discussions),
        maxPages,
        signal,
      )
      streams.push(discussions)
      next.discussions = later(cursor.discussions, discussions.newest)
    }
    if (streams.some((stream) => !stream.complete)) message = 'partial: continues on the next run'
  } catch (error) {
    if (signal?.aborted) throw error
    message =
      error instanceof GitHubRateLimitError
        ? error.message
        : `GitHub: ${error instanceof Error ? error.message : String(error)}`
    input.log?.(`issues of ${current.name}: ${message}`)
    if (streams.length === 0) {
      await record({ status: 'failed', at, message })
      return { status: 'failed', stored: 0, scanned: 0, message }
    }
  }

  const tokens = repo.directory ? packageTokens(current.name, repo.directory) : undefined
  const unique = new Map(
    streams.flatMap((stream) => stream.threads).map((thread) => [thread.id, thread]),
  )
  const ranked = [...unique.values()]
    .filter(
      (thread) =>
        Date.parse(thread.createdAt) >= Date.parse(windowStart) && keepThread(thread, minReactions),
    )
    .map((thread) => ({ thread, relevance: tokens ? packageRelevance(thread, tokens) : 'match' }))
    .filter((entry) => entry.relevance !== 'other')
    .toSorted((a, b) => (a.relevance === b.relevance ? 0 : a.relevance === 'match' ? -1 : 1))
    .slice(0, maxIssues)

  const stored: LibraryIssue[] = ranked.map(({ thread }) =>
    Object.assign(thread, { ecosystem: current.ecosystem, name: current.name }),
  )
  if (stored.length > 0) {
    const previous = await Promise.all(stored.map((issue) => store.getIssue(issue.id)))
    for (const [index, issue] of stored.entries()) {
      const digest = previous[index]?.digest
      if (digest && previous[index]?.state === issue.state) issue.digest = digest
    }
    await store.putIssues(stored)
  }
  const scanned = streams.reduce((sum, stream) => sum + stream.scanned, 0)
  const failed = message !== undefined && !message.startsWith('partial')
  const status: LibrarySourceStatus['status'] = failed ? 'failed' : 'ok'
  await record({ status, at, ...(message ? { message } : {}) }, next)
  input.log?.(`issues of ${current.name}: ${stored.length} stored of ${scanned} read`)
  return { status, stored: stored.length, scanned, ...(message ? { message } : {}) }
}
