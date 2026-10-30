import type { RepoRef } from '@holtkeeper/forge'
import type { Job, JobStore, JobTrigger, Timestamp } from '@holtkeeper/store'

/** A job to create; `enqueueUnique` fills in the timestamps. */
export interface JobRequest {
  analyzer: string
  repo: RepoRef
  group?: string
  ref?: string
  options?: Record<string, unknown>
  trigger: JobTrigger
  actor?: string
  /** Schedule that asked for the job. */
  schedule?: string
  /** Not claimed before this time; default: at once. */
  runAfter?: Timestamp
}

const sameRef = (a: string | undefined, b: string | undefined) => (a ?? '') === (b ?? '')

/**
 * Enqueues each request unless a queued or running job already covers the same analyzer,
 * repository and ref.
 */
export async function enqueueUnique(
  store: JobStore,
  requests: JobRequest[],
  at: Timestamp,
): Promise<{ enqueued: Job[]; skipped: JobRequest[] }> {
  const enqueued: Job[] = []
  const skipped: JobRequest[] = []
  for (const request of requests) {
    const active = await store.list({
      status: ['queued', 'running'],
      repo: request.repo,
      analyzer: request.analyzer,
      limit: 500,
    })
    if (active.some((job) => sameRef(job.ref, request.ref))) {
      skipped.push(request)
      continue
    }
    enqueued.push(await store.enqueue({ ...request, createdAt: at }))
  }
  return { enqueued, skipped }
}
