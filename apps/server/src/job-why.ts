import type { JobWhy } from '@holtkeeper/api'
import { claimRulesOf, waitReasons } from '@holtkeeper/jobs'
import type { Job, JobTrigger } from '@holtkeeper/store'

import type { ServerDeps } from './context.ts'

/** Queued and running jobs `explainJob` reads for queue positions. */
const QUEUE_SCAN = 1000

const triggers: Record<JobTrigger, (job: Job) => string> = {
  schedule: (job) => `Schedule ${job.schedule ?? 'unknown'} queued it`,
  manual: (job) =>
    job.schedule ? `A person ran schedule ${job.schedule} by hand` : 'A person queued it by hand',
  command: () => 'A chat or merge request command queued it',
  webhook: () => 'A forge webhook queued it',
  tag: (job) => (job.ref ? `The tag ${job.ref} queued it` : 'A new tag queued it'),
  push: (job) => `A push to ${job.ref ?? 'the default branch'} queued it`,
  poll: () => 'Polling the forge found a change and queued it',
  'new-repo': () => 'The new repository trigger queued it',
  freshness: (job) =>
    job.reason ? `Freshness queued it: ${job.reason}` : 'Freshness queued it: the record was stale',
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? text

/** Why `job` exists, in a sentence: the trigger with its schedule or ref, and the attempt. */
function jobOrigin(job: Job): string {
  const origin = (triggers[job.trigger] ?? (() => `A ${job.trigger} event queued it`))(job)
  return job.attempts > 1 ? `${origin}; attempt ${job.attempts} of ${job.maxAttempts}` : origin
}

/** How a job that left the queue stands, in a sentence; `undefined` while queued. */
function jobOutcome(job: Job): string | undefined {
  const failedStep = job.attemptsHistory.at(-1)?.step
  switch (job.status) {
    case 'queued':
      return undefined
    case 'running':
      return `Running on ${job.workerId ?? 'a worker'} since ${job.startedAt ?? job.createdAt}`
    case 'succeeded':
      return job.analysisId ? 'Succeeded and stored its result' : 'Succeeded'
    case 'failed':
      return `Failed${failedStep ? ` in step ${failedStep}` : ''}: ${firstLine(job.error ?? 'unknown error')}`
    case 'blocked':
      return `The AI budget stopped it, so it is not retried: ${firstLine(job.error ?? 'budget reached')}`
    default:
      return 'Canceled'
  }
}

/**
 * Why `job` ran or why it still waits: its origin, its outcome, and for a queued job the claim
 * rules that hold it back and the due jobs ahead of it. `people` is left empty for the caller.
 */
export async function explainJob(
  deps: Pick<ServerDeps, 'store' | 'analyzers' | 'now'>,
  job: Job,
): Promise<JobWhy> {
  const outcome = jobOutcome(job)
  const base: JobWhy = {
    origin: jobOrigin(job),
    ...(job.actor !== undefined && { actor: job.actor }),
    ...(outcome !== undefined && { outcome }),
    people: {},
  }
  if (job.status !== 'queued') return base
  const queue = await deps.store.jobs.list({ status: ['queued', 'running'], limit: QUEUE_SCAN })
  const rules = claimRulesOf(deps.analyzers ?? [])
  return { ...base, wait: waitReasons(job, queue, rules, deps.now().toISOString()) }
}
