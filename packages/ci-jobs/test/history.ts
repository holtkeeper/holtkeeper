import type { GitForge, JobRun, PipelineRun } from '@holtkeeper/forge'
import type { CiJobRecord } from '@holtkeeper/store'

export const repo = { forge: 'gitlab', path: 'g/a' }

const START = Date.parse('2026-07-01T00:00:00.000Z')

/** `day` days and `hours` hours after 2026-07-01, as ISO 8601. */
export const at = (day: number, hours = 0) =>
  new Date(START + day * 86_400_000 + hours * 3_600_000).toISOString()

let nextId = 1

/** A finished job attempt created at `createdAt`, starting a minute later. */
export function attempt(
  name: string,
  createdAt: string,
  durationSeconds: number,
  overrides: Partial<CiJobRecord> = {},
): CiJobRecord {
  const jobId = overrides.jobId ?? nextId++
  const start = Date.parse(createdAt) + 60_000
  return {
    repo,
    jobId,
    pipelineId: 0,
    name,
    stage: name === 'build' ? 'build' : 'test',
    status: 'success',
    ref: 'main',
    sha: `sha${jobId}`,
    createdAt,
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date(start + durationSeconds * 1000).toISOString(),
    durationSeconds,
    queuedSeconds: 30,
    allowFailure: false,
    webUrl: `https://g.example/g/a/-/jobs/${jobId}`,
    ...overrides,
  }
}

/**
 * 90 days with one pipeline a day: `build` takes 100 s until day 75 and 160 s after, `test`
 * takes 50 s and fails every tenth day, failing once then passing on day 5, `lint` always fails
 * but may. `feature` pipelines run `build` on another branch every third day, and a tag pipeline
 * runs `deploy` on days 29, 59 and 89.
 */
export function quarter(): CiJobRecord[] {
  const records: CiJobRecord[] = []
  for (let day = 0; day < 90; day++) {
    const pipelineId = 1000 + day
    const created = at(day, 10)
    records.push(attempt('build', created, day >= 75 ? 160 : 100, { pipelineId }))
    if (day === 5) {
      records.push(attempt('test', created, 50, { pipelineId, status: 'failed' }))
      records.push(attempt('test', created, 50, { pipelineId }))
    } else
      records.push(
        attempt('test', created, 50, { pipelineId, status: day % 10 === 9 ? 'failed' : 'success' }),
      )
    records.push(attempt('lint', created, 10, { pipelineId, status: 'failed', allowFailure: true }))
    if (day % 3 === 0)
      records.push(attempt('build', at(day, 12), 300, { pipelineId: 5000 + day, ref: 'feature' }))
    if (day % 30 === 29)
      records.push(
        attempt('deploy', at(day, 14), 600, {
          pipelineId: 7000 + day,
          ref: `v1.${day}.0`,
          tag: true,
        }),
      )
  }
  return records
}

const unsupported = () => {
  throw new Error('not supported by the fake forge')
}

const newestFirst = (list: JobRun[]) => list.toSorted((a, b) => b.id - a.id)

/** Records as forge job runs, retried attempts flagged. */
export function toJobRuns(records: readonly CiJobRecord[]): JobRun[] {
  return records.map((r) => ({
    id: r.jobId,
    name: r.name,
    stage: r.stage,
    status: r.status,
    webUrl: r.webUrl,
    pipelineId: r.pipelineId,
    createdAt: r.createdAt,
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    ...(r.durationSeconds === undefined ? {} : { durationSeconds: r.durationSeconds }),
    ...(r.queuedSeconds === undefined ? {} : { queuedSeconds: r.queuedSeconds }),
    retried: records.some(
      (o) => o.pipelineId === r.pipelineId && o.name === r.name && o.jobId > r.jobId,
    ),
    allowFailure: r.allowFailure,
    ...(r.ref ? { ref: r.ref } : {}),
    ...(r.sha ? { sha: r.sha } : {}),
  }))
}

/**
 * A `GitForge` serving `jobs` through `listProjectJobRuns`, or per pipeline when `perPipeline`.
 * `calls` records each read with its `after`.
 */
export function fakeForge(
  jobs: () => JobRun[],
  options: { perPipeline?: boolean } = {},
): GitForge & { calls: string[] } {
  const calls: string[] = []
  const forge: GitForge & { calls: string[] } = {
    kind: 'fake',
    calls,
    listRepositories: unsupported,
    getRepository: async (path) => ({
      path,
      name: path,
      defaultBranch: 'main',
      webUrl: `https://g.example/${path}`,
      cloneUrl: `https://g.example/${path}.git`,
      archived: false,
    }),
    readFile: unsupported,
    createBranch: unsupported,
    deleteBranch: unsupported,
    commit: unsupported,
    findMergeRequest: unsupported,
    createMergeRequest: unsupported,
    updateMergeRequest: unsupported,
    mergeMergeRequest: unsupported,
    commentOnMergeRequest: unsupported,
    listPipelines: unsupported,
    listJobs: unsupported,
    playJob: unsupported,
    retryJob: unsupported,
    createTag: unsupported,
  }
  if (options.perPipeline) {
    forge.listPipelineRuns = async (_repo, query = {}) => {
      calls.push(`pipelines after ${query.after ?? ''}`)
      const byId = new Map<number, PipelineRun>()
      for (const job of jobs())
        if (!query.after || job.createdAt >= query.after)
          byId.set(job.pipelineId, {
            id: job.pipelineId,
            ref: 'main',
            sha: `p${job.pipelineId}`,
            status: 'success',
            webUrl: '',
            createdAt: job.createdAt,
          })
      return [...byId.values()].toSorted((a, b) => b.id - a.id).slice(0, query.limit)
    }
    forge.listJobRuns = async (_repo, pipelineId) =>
      jobs()
        .filter((j) => j.pipelineId === pipelineId)
        .map((job) => {
          const copy = { ...job }
          delete copy.ref
          delete copy.sha
          return copy
        })
  } else
    forge.listProjectJobRuns = async (_repo, query = {}) => {
      calls.push(`jobs after ${query.after ?? ''}`)
      return newestFirst(jobs().filter((j) => !query.after || j.createdAt >= query.after)).slice(
        0,
        query.limit,
      )
    }
  return forge
}
