import { type AnyAnalyzer, DEFAULT_POOL } from '@holtkeeper/analyzer'
import type { ClaimRules, Job } from '@holtkeeper/store'

/**
 * The claim rules the analyzers declare: exclusive kinds, `interactive` kinds as `priority`, the
 * kinds each one runs `after` and,
 * for a worker serving `pools` (default `[DEFAULT_POOL]`), the kinds of the pools it does not
 * serve (`except`). A worker that serves no `DEFAULT_POOL` takes only the kinds of its pools
 * (`only`), so it never claims jobs of unknown analyzers either.
 */
export function claimRulesOf(
  analyzers: readonly Pick<AnyAnalyzer, 'kind' | 'exclusive' | 'after' | 'pool' | 'interactive'>[],
  delayMs?: number,
  pools: readonly string[] = [DEFAULT_POOL],
): ClaimRules {
  const served = (analyzer: Pick<AnyAnalyzer, 'pool'>) =>
    pools.includes(analyzer.pool ?? DEFAULT_POOL)
  const others = analyzers.filter((analyzer) => !served(analyzer)).map((a) => a.kind)
  const priority = analyzers.filter((analyzer) => analyzer.interactive).map((a) => a.kind)
  return {
    ...(pools.includes(DEFAULT_POOL)
      ? others.length > 0 && { except: others }
      : { only: analyzers.filter(served).map((a) => a.kind) }),
    exclusive: analyzers.filter((analyzer) => analyzer.exclusive).map((a) => a.kind),
    after: Object.fromEntries(
      analyzers.flatMap((analyzer) => (analyzer.after ? [[analyzer.kind, analyzer.after]] : [])),
    ),
    ...(priority.length > 0 && { priority }),
    ...(delayMs && { delayMs }),
  }
}

/** One thing that keeps a queued job from being claimed right now. */
export type WaitReason =
  /** `runAfter` is in the future: a retry after a failed attempt, or a spread or delayed start. */
  | { kind: 'retry'; at: string; attempt: number }
  | { kind: 'scheduled'; at: string }
  /** A job of the same analyzer runs on the repository. */
  | { kind: 'same-analyzer'; analyzer: string }
  /** The job changes the repository and so waits until nothing runs there. */
  | { kind: 'exclusive-self'; running: number }
  /** An exclusive job runs on the repository, or is queued ahead of this one there. */
  | { kind: 'exclusive'; analyzer: string; state: 'running' | 'queued' }
  /** The job reads the results of `analyzer`, which runs or is queued ahead of it there. */
  | { kind: 'after'; analyzer: string; state: 'running' | 'queued' }

/** Why a queued job has not started, as `waitReasons` sees it. */
export interface JobWait {
  /** Empty when nothing holds the job back but free worker slots. */
  reasons: WaitReason[]
  /**
   * Due queued jobs ahead of it in claim order (`ClaimRules.priority` kinds first), across every
   * repository.
   */
  ahead: number
}

const sameTarget = (a: Job, b: Job) =>
  a.repo.forge === b.repo.forge && a.repo.path === b.repo.path && a.group === b.group

const claimOrder = (a: Job, b: Job) =>
  a.runAfter.localeCompare(b.runAfter) || a.createdAt.localeCompare(b.createdAt)

/**
 * Why `job` waits in the queue at `now` under `rules`, from the queued and running jobs in
 * `queue` (other repositories included, for `ahead`). Mirrors the conditions of
 * `JobStore.claim`; a job that is not queued has no reasons.
 */
export function waitReasons(
  job: Job,
  queue: readonly Job[],
  rules: ClaimRules,
  now: string,
): JobWait {
  if (job.status !== 'queued') return { reasons: [], ahead: 0 }
  const others = queue.filter((other) => other.id !== job.id)
  const isAhead = (other: Job) => other.status === 'queued' && claimOrder(other, job) < 0
  const urgent = (other: Job) => Number(rules.priority?.includes(other.analyzer) ?? false)
  const claimedFirst = (other: Job) =>
    other.status === 'queued' && (urgent(other) - urgent(job) || -claimOrder(other, job)) > 0
  const ahead = others.filter((other) => claimedFirst(other) && other.runAfter <= now).length
  const here = others.filter((other) => sameTarget(other, job))
  const running = here.filter((other) => other.status === 'running')
  const queuedAhead = urgent(job) ? [] : here.filter(isAhead)
  const exclusive = new Set(rules.exclusive ?? [])
  const after = new Set(rules.after?.[job.analyzer] ?? [])
  const reasons: WaitReason[] = []

  if (job.runAfter > now)
    reasons.push(
      job.attempts > 0
        ? { kind: 'retry', at: job.runAfter, attempt: job.attempts }
        : { kind: 'scheduled', at: job.runAfter },
    )
  if (running.some((other) => other.analyzer === job.analyzer))
    reasons.push({ kind: 'same-analyzer', analyzer: job.analyzer })
  if (exclusive.has(job.analyzer) && running.length)
    reasons.push({ kind: 'exclusive-self', running: running.length })
  const seen = new Set<string>()
  const add = (reason: Extract<WaitReason, { analyzer: string; state: string }>) => {
    const key = `${reason.kind}:${reason.analyzer}`
    if (seen.has(key)) return
    seen.add(key)
    reasons.push(reason)
  }
  for (const [state, jobs] of [
    ['running', running],
    ['queued', queuedAhead],
  ] as const)
    for (const other of jobs) {
      if (exclusive.has(other.analyzer) && other.analyzer !== job.analyzer)
        add({ kind: 'exclusive', analyzer: other.analyzer, state })
      else if (after.has(other.analyzer)) add({ kind: 'after', analyzer: other.analyzer, state })
    }
  return { reasons, ahead }
}

/** A wait reason in one sentence, with times as ISO timestamps. */
export function describeWaitReason(reason: WaitReason): string {
  switch (reason.kind) {
    case 'retry':
      return `retries at ${reason.at} after attempt ${reason.attempt} failed`
    case 'scheduled':
      return `not due before ${reason.at}`
    case 'same-analyzer':
      return `a ${reason.analyzer} job already runs on this repository`
    case 'exclusive-self':
      return `it changes the repository, so it waits for ${reason.running} running job${reason.running === 1 ? '' : 's'} there`
    case 'exclusive':
      return `the exclusive ${reason.analyzer} job ${reason.state === 'running' ? 'runs' : 'is queued ahead'} on this repository`
    default:
      return `waits for ${reason.analyzer} on this repository (${reason.state === 'running' ? 'running' : 'queued ahead'}), whose results it reads`
  }
}
