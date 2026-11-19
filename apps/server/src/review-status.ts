import type { RepoTarget } from '@holtkeeper/access'
import { ToolError } from '@holtkeeper/agent-tools'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { Discussion, GitForge, MergeRequest, RepoRef } from '@holtkeeper/forge'
import { selectionCovers } from '@holtkeeper/jobs'
import {
  type ReviewData,
  type ReviewFinding,
  commentFinding,
  reviewDataSchema,
  reviewRef,
} from '@holtkeeper/review'
import type { Job, JobStatus, Store } from '@holtkeeper/store'

import { repoTarget } from './context.ts'
import { commentsOffFor, isReviewAnalyzer } from './mr-comments.ts'
import { reviewTargetOf } from './mr-status.ts'
import { analyzerOffFor } from './repo-analyzers.ts'
import type { ReviewToolsAccess } from './tools/reviews.ts'

/** Review records of a repository `mergeRequestReviewStatus` reads, newest first. */
const RECORD_SCAN = 100

/** Review runs of one merge request it returns at most, newest first. */
const RUNS = 5

/** Jobs of a repository it reads to find the merge request's review jobs, newest first. */
const JOB_SCAN = 200

/** One stored review run of a merge request. */
interface ReviewRun {
  createdAt: string
  data: ReviewData
}

/** A review job of the merge request that is waiting or running. */
interface ActiveReviewJob {
  id: string
  status: 'queued' | 'running'
  createdAt: string
  startedAt?: string
  /** The head commit it reviews. */
  ref?: string
}

/** The newest review job that ended without a stored review, newer than the newest run. */
interface FailedReviewJob {
  id: string
  status: Extract<JobStatus, 'failed' | 'blocked' | 'canceled'>
  at: string
  /** First line of the error. */
  error?: string
}

/** An unresolved inline thread a Holtkeeper review opened. */
interface OpenReviewThread {
  path?: string
  line?: number
  severity?: ReviewFinding['severity']
  category?: string
  title: string
  /** Replies after the finding, other than Holtkeeper's own. */
  replies: number
}

/** Everything `review_status` says about one merge request. */
export interface MergeRequestReviewStatus {
  repo: RepoRef
  mergeRequest: MergeRequest & { headSha?: string }
  /** Set while `mergeRequests.comments` or `repo.analyzers` keeps reviews off the repository. */
  off?: { reason?: string }
  /** Whether new commits queue a review by themselves, and why not when they do not. */
  automatic: { enabled: boolean; reason?: string }
  active?: ActiveReviewJob
  failed?: FailedReviewJob
  /** Runs that reviewed the merge request (or skipped it), newest first; thread replies left out. */
  runs: ReviewRun[]
  /** Unresolved Holtkeeper threads; absent when the forge cannot list discussions. */
  openThreads?: OpenReviewThread[]
}

/** What `mergeRequestReviewStatus` reads. */
interface ReviewStatusDeps {
  store: Pick<Store, 'analyses' | 'jobs' | 'settings'>
  config: HoltkeeperConfig
  /** The forge client of the repository's forge. */
  forge: GitForge
}

/** What `reviewToolsAccess` needs to answer and to queue reviews. */
export interface ReviewToolsDeps {
  store: ReviewStatusDeps['store'] & Partial<Pick<Store, 'kv'>>
  config: HoltkeeperConfig
  /** Repositories Holtkeeper must not change; no review is queued for them. */
  readOnly?: (repo: RepoRef) => Promise<boolean>
  /** Told about a queued review job. */
  onQueued?: (job: Job) => void
  now?: () => Date
}

/**
 * How long a request waits for the automatic review of new commits before it queues one itself,
 * so a webhook that is seconds away and the request do not both start a review.
 */
const AUTOMATIC_REVIEW_GRACE_MS = 60_000

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? text

// A run that found nothing new since an earlier head says nothing about the merge request.
const nothingNew = (data: ReviewData) =>
  data.mode === 'skipped' && !data.skipped.some((file) => file.reason === 'too-large')

/**
 * The merge request a source branch or number names: an open one for a branch when there is one,
 * else the newest of any state; `undefined` when none.
 */
async function findMergeRequest(
  forge: GitForge,
  repo: RepoRef,
  query: { mergeRequest?: number; branch?: string },
): Promise<(MergeRequest & { headSha?: string }) | undefined> {
  if (query.mergeRequest !== undefined) {
    if (forge.getMergeRequest) return forge.getMergeRequest(repo.path, query.mergeRequest)
    return undefined
  }
  if (!query.branch) return undefined
  const open = await forge.findMergeRequest(repo.path, {
    sourceBranch: query.branch,
    state: 'open',
  })
  const found = open ?? (await forge.findMergeRequest(repo.path, { sourceBranch: query.branch }))
  if (!found || !forge.getMergeRequest) return found
  return forge.getMergeRequest(repo.path, found.id)
}

/** Whether a new commit on `mr` queues a review through `jobs.onMergeRequest`, and why not. */
function automaticReview(
  config: HoltkeeperConfig,
  repo: RepoRef,
  mr: Pick<MergeRequest, 'draft'>,
): MergeRequestReviewStatus['automatic'] {
  const trigger = config.jobs?.onMergeRequest
  if (!trigger || !trigger.analyzers.some((kind) => isReviewAnalyzer(config, kind)))
    return { enabled: false, reason: 'merge requests are not reviewed automatically' }
  if (!(trigger.actions ?? ['open', 'update', 'reopen']).includes('update'))
    return { enabled: false, reason: 'new commits do not queue a review' }
  if (!selectionCovers(config, trigger, repo))
    return { enabled: false, reason: 'automatic reviews do not cover this repository' }
  if (mr.draft && !trigger.draft)
    return { enabled: false, reason: 'draft merge requests are not reviewed automatically' }
  return { enabled: true }
}

/** Unresolved threads whose first note is a Holtkeeper finding, matched to stored findings. */
function openThreads(
  discussions: readonly Discussion[],
  findings: ReadonlyMap<string, ReviewFinding>,
  botUsername: string | undefined,
): OpenReviewThread[] {
  const threads: OpenReviewThread[] = []
  for (const discussion of discussions) {
    if (!discussion.resolvable || discussion.resolved) continue
    const [first, ...rest] = discussion.notes.filter((note) => !note.system)
    const marked = first && commentFinding(first.body)
    if (!first || !marked) continue
    const finding = findings.get(marked.findingId)
    const title =
      finding?.title ??
      /— \*\*(.+?)\*\*/.exec(first.body)?.[1] ??
      firstLine(first.body).replaceAll('*', '')
    const path = finding?.path ?? discussion.position?.path
    const line = finding?.line ?? discussion.position?.line
    threads.push({
      ...(path !== undefined && { path }),
      ...(line !== undefined && { line }),
      severity: finding?.severity ?? marked.severity,
      category: marked.category,
      title,
      replies: rest.filter(
        (note) =>
          note.author !== botUsername && note.author !== first.author && !commentFinding(note.body),
      ).length,
    })
  }
  return threads
}

/**
 * The review state of one merge request, from stored review runs and jobs plus the forge's open
 * threads: the newest runs (thread replies and runs that found nothing new left out), a waiting
 * or running review job, the newest review job that failed since the last run, whether reviews
 * are off or run by themselves on new commits, and the unresolved threads Holtkeeper opened.
 * The caller checks that the asker may read the repository's analyses.
 */
async function mergeRequestReviewStatus(
  deps: ReviewStatusDeps,
  repo: RepoRef,
  mergeRequest: MergeRequest & { headSha?: string },
): Promise<MergeRequestReviewStatus> {
  const { store, config, forge } = deps
  const ref = reviewRef(mergeRequest.id)
  const [records, jobs, commentsOff, analyzerOff, discussions] = await Promise.all([
    store.analyses.list({ repo, kind: 'review', limit: RECORD_SCAN }),
    store.jobs.list({ repo, limit: JOB_SCAN }),
    commentsOffFor(store, config, repo),
    analyzerOffFor(store, config, repo, 'review'),
    forge.listDiscussions?.(repo.path, mergeRequest.id).catch(() => undefined),
  ])

  const runs: ReviewRun[] = []
  const findings = new Map<string, ReviewFinding>()
  for (const record of records) {
    if (record.ref !== ref) continue
    const parsed = reviewDataSchema.safeParse(record.data)
    if (!parsed.success) continue
    for (const finding of parsed.data.comments)
      if (!findings.has(finding.id)) findings.set(finding.id, finding)
    if (parsed.data.mode === 'reply' || nothingNew(parsed.data)) continue
    if (runs.length < RUNS) runs.push({ createdAt: record.createdAt, data: parsed.data })
  }

  const reviews: Job[] = jobs.filter(
    (job) => reviewTargetOf(config, job)?.mergeRequest === mergeRequest.id,
  )
  const running = reviews.find((job) => job.status === 'queued' || job.status === 'running')
  const lastRun = runs[0]?.createdAt ?? ''
  const ended = reviews.find(
    (job) =>
      (job.status === 'failed' || job.status === 'blocked' || job.status === 'canceled') &&
      (job.finishedAt ?? job.createdAt) > lastRun,
  )

  const off = commentsOff ?? analyzerOff
  return {
    repo,
    mergeRequest,
    ...(off && { off }),
    automatic: automaticReview(config, repo, mergeRequest),
    ...(running && {
      active: {
        id: running.id,
        status: running.status === 'running' ? 'running' : 'queued',
        createdAt: running.createdAt,
        ...(running.startedAt && { startedAt: running.startedAt }),
        ...(running.ref && { ref: running.ref }),
      },
    }),
    ...(ended && {
      failed: {
        id: ended.id,
        status:
          ended.status === 'blocked'
            ? 'blocked'
            : ended.status === 'failed'
              ? 'failed'
              : 'canceled',
        at: ended.finishedAt ?? ended.createdAt,
        ...(ended.error && { error: firstLine(ended.error) }),
      },
    }),
    runs,
    ...(discussions && {
      openThreads: openThreads(discussions, findings, config.jobs.botUsernames?.[repo.forge]),
    }),
  }
}

const parseRepo = (value: string): RepoRef | undefined => {
  const separator = value.indexOf(':')
  return separator > 0 && separator < value.length - 1
    ? { forge: value.slice(0, separator), path: value.slice(separator + 1) }
    : undefined
}

/**
 * `code_review` for one caller: repositories the caller may read analyses of (`canRead`) on a
 * configured forge, merge requests found through the forge, the state from
 * `mergeRequestReviewStatus`. `review` also makes sure a review of the head is coming: when the
 * merge request is open, reviews are on, the repository is not read-only, no review job waits or
 * runs and no run covers the head, it queues a plain review of the head (trigger `command`, the
 * same job a webhook queues, so the two never run twice). While reviews start by themselves on
 * new commits it first waits `AUTOMATIC_REVIEW_GRACE_MS` from the first request for that head
 * (remembered in `store.kv`; without it the wait is skipped). Anything it cannot do is a
 * `ToolError` the agent can act on.
 */
export function reviewToolsAccess(
  deps: ReviewToolsDeps,
  canRead: (target: RepoTarget) => boolean,
): ReviewToolsAccess {
  const now = deps.now ?? (() => new Date())

  const find = async (value: string, query: { mergeRequest?: number; branch?: string }) => {
    const repo = parseRepo(value)
    const forge = repo && deps.config.forges[repo.forge]?.create()
    if (!repo || !forge || !canRead(repoTarget(deps.config, repo)))
      throw new ToolError(`No repository ${value} you may read reviews of; pass forge:path.`)
    const bot = deps.config.jobs?.botUsernames?.[repo.forge]
    const mr = await findMergeRequest(forge, repo, query).catch((error: unknown) => {
      throw new ToolError(
        `Holtkeeper${bot ? ` (forge user ${bot})` : ''} could not read merge requests of ${value}: ${firstLine(error instanceof Error ? error.message : String(error))}. Ask a maintainer to give it access to the repository; it needs to read merge requests and comment on them.`,
      )
    })
    if (!mr)
      throw new ToolError(
        query.branch === undefined
          ? `Holtkeeper sees no merge request !${query.mergeRequest} in ${value}. Check the number, and that Holtkeeper${bot ? ` (forge user ${bot})` : ''} has access to the repository.`
          : `Holtkeeper reviews merge requests, and there is none from branch ${query.branch} in ${value}. Push the branch, open a merge request and call code_review again.`,
      )
    return { repo, forge, mr }
  }

  const status: ReviewToolsAccess['status'] = async (value, query) => {
    const { repo, forge, mr } = await find(value, query)
    return mergeRequestReviewStatus({ ...deps, forge }, repo, mr)
  }

  return {
    status,
    async review(value, query) {
      const { repo, forge, mr } = await find(value, query)
      const current = await mergeRequestReviewStatus({ ...deps, forge }, repo, mr)
      const head = mr.headSha
      const reviewed = current.runs[0]?.data.head
      if (current.off || mr.state !== 'open' || current.active || !head || reviewed === head)
        return { status: current }
      if (await deps.readOnly?.(repo)) return { status: current, request: 'read-only' }

      const { kv } = deps.store
      if (current.automatic.enabled && kv) {
        const key = `review-request:${repo.forge}:${repo.path}!${mr.id}:${head}`
        const first = Number(await kv.get(key)) || 0
        if (!first) {
          await kv.set(key, now().getTime(), 24 * 60 * 60)
          return { status: current, request: 'automatic' }
        }
        if (now().getTime() - first < AUTOMATIC_REVIEW_GRACE_MS)
          return { status: current, request: 'automatic' }
      }

      const createdAt = now().toISOString()
      const job = await deps.store.jobs.enqueue({
        analyzer: deps.config.jobs?.commands?.review?.analyzer ?? 'review',
        repo,
        ref: head,
        options: { mergeRequest: mr.id },
        trigger: 'command',
        createdAt,
      })
      deps.onQueued?.(job)
      return {
        status: {
          ...current,
          active: { id: job.id, status: 'queued', createdAt, ref: head },
        },
        request: 'queued',
      }
    },
  }
}
