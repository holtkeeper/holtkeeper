import type { Limiter } from './limiter.ts'

export interface LimitJobsOptions<Job> {
  limiter: Limiter
  /** Limiter keys (credential ids) the job will use; `[]` when it uses none. */
  keysFor(job: Job): readonly string[] | Promise<readonly string[]>
}

/**
 * An admission hook for the job worker (`WorkerOptions.admission`): `false` while any key the job
 * needs is saturated (see `Limiter.saturated`), so the worker leaves the job waiting and runs
 * others. It only advises; the wrapped clients still wait for capacity themselves.
 */
export function limitJobs<Job>(options: LimitJobsOptions<Job>): (job: Job) => Promise<boolean> {
  return async (job) => {
    for (const key of await options.keysFor(job)) {
      if (await options.limiter.saturated(key)) return false
    }
    return true
  }
}
