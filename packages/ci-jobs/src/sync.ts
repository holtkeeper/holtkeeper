import type { GitForge, JobRun, PipelineRun } from '@holtkeeper/forge'
import type { CiJobRecord, CiJobStore } from '@holtkeeper/store'

import { addDays } from './stats.ts'

/** How far before the newest stored job an incremental sync starts, to pick up late finishers. */
const OVERLAP_DAYS = 1

/** Pipelines whose jobs the per-pipeline fallback reads at most. */
const FALLBACK_PIPELINES = 300

export interface SyncResult {
  mode: 'full' | 'incremental' | 'none'
  after?: string
  /** Job attempts the forge returned. */
  fetched: number
  /** Finished attempts written to the store. */
  stored: number
  /** Earliest time a full sync has covered, to remember for the next run. */
  syncedFrom?: string
  notes: string[]
}

const finished = (status: string): status is CiJobRecord['status'] =>
  status === 'success' || status === 'failed' || status === 'canceled'

function toRecord(repo: CiJobRecord['repo'], job: JobRun): CiJobRecord | undefined {
  if (!finished(job.status)) return undefined
  return {
    repo,
    jobId: job.id,
    pipelineId: job.pipelineId,
    name: job.name,
    stage: job.stage,
    status: job.status,
    ...(job.ref ? { ref: job.ref } : {}),
    ...(job.sha ? { sha: job.sha } : {}),
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.durationSeconds === undefined ? {} : { durationSeconds: job.durationSeconds }),
    ...(job.queuedSeconds === undefined ? {} : { queuedSeconds: job.queuedSeconds }),
    allowFailure: job.allowFailure,
    webUrl: job.webUrl,
  }
}

async function perPipeline(
  forge: GitForge,
  repo: string,
  after: string,
  notes: string[],
): Promise<JobRun[]> {
  if (!forge.listPipelineRuns || !forge.listJobRuns) {
    notes.push(`The ${forge.kind} forge cannot list jobs; no CI history was fetched.`)
    return []
  }
  const listJobRuns = forge.listJobRuns.bind(forge)
  const pipelines: PipelineRun[] = await forge.listPipelineRuns(repo, {
    after,
    limit: FALLBACK_PIPELINES,
  })
  if (pipelines.length >= FALLBACK_PIPELINES)
    notes.push(
      `The forge lists jobs per pipeline; only the newest ${FALLBACK_PIPELINES} were read.`,
    )
  const jobs: JobRun[] = []
  for (let i = 0; i < pipelines.length; i += 4) {
    const batch = pipelines.slice(i, i + 4)
    // oxlint-disable-next-line no-await-in-loop -- a few pipelines at a time keeps the forge happy
    const lists = await Promise.all(batch.map((p) => listJobRuns(repo, p.id)))
    lists.forEach((list, index) => {
      const pipeline = batch[index]
      for (const job of list)
        jobs.push(
          pipeline ? { ...job, ref: job.ref ?? pipeline.ref, sha: job.sha ?? pipeline.sha } : job,
        )
    })
  }
  return jobs
}

/**
 * Brings the stored job history of `repo` up to date. The first run, or one asking further back
 * than any earlier full sync (`syncedFrom`), reads everything since `since`; later runs read only
 * from a day before the newest stored job. Only finished attempts are stored.
 */
export async function syncCiJobs(options: {
  forge: GitForge
  store: CiJobStore
  repo: CiJobRecord['repo']
  since: string
  syncedFrom?: string
  /** Attempts read at most; a full sync of a busy repository stops here. */
  limit: number
  log?: (line: string) => void
}): Promise<SyncResult> {
  const { forge, store, repo, since } = options
  const notes: string[] = []
  const coverage = await store.coverage(repo)
  const full =
    !coverage ||
    options.syncedFrom === undefined ||
    Date.parse(options.syncedFrom) > Date.parse(since)
  const after = full || !coverage ? since : addDays(coverage.newest, -OVERLAP_DAYS)

  const jobs = forge.listProjectJobRuns
    ? await forge.listProjectJobRuns(repo.path, { after, limit: options.limit })
    : await perPipeline(forge, repo.path, after, notes)
  if (jobs.length >= options.limit)
    notes.push(
      `The sync stopped after ${options.limit} job attempts; history before ${jobs.at(-1)?.createdAt.slice(0, 10)} is incomplete.`,
    )
  const records = jobs.flatMap((job) => toRecord(repo, job) ?? [])
  await store.put(records)
  options.log?.(
    `ci-jobs: ${full ? 'full' : 'incremental'} sync after ${after}: ${jobs.length} fetched, ${records.length} stored`,
  )
  const syncedFrom = full ? since : options.syncedFrom
  return {
    mode: full ? 'full' : 'incremental',
    after,
    fetched: jobs.length,
    stored: records.length,
    ...(syncedFrom ? { syncedFrom } : {}),
    notes,
  }
}
