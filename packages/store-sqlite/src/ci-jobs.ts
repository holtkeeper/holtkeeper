import type { Database } from 'bun:sqlite'

import type { CiJobRecord, CiJobStore } from '@holtkeeper/store'
import { normalizeCiJob } from '@holtkeeper/store'

interface CiJobRow {
  repo_forge: string
  repo_path: string
  job_id: number
  pipeline_id: number
  name: string
  stage: string
  status: CiJobRecord['status']
  ref: string | null
  sha: string | null
  tag: number
  created_at: string
  started_at: string | null
  finished_at: string | null
  duration_seconds: number | null
  queued_seconds: number | null
  allow_failure: number
  web_url: string
}

const toRecord = (r: CiJobRow): CiJobRecord => ({
  repo: { forge: r.repo_forge, path: r.repo_path },
  jobId: r.job_id,
  pipelineId: r.pipeline_id,
  name: r.name,
  stage: r.stage,
  status: r.status,
  ...(r.ref !== null && { ref: r.ref }),
  ...(r.sha !== null && { sha: r.sha }),
  ...(r.tag === 1 && { tag: true }),
  createdAt: r.created_at,
  ...(r.started_at !== null && { startedAt: r.started_at }),
  ...(r.finished_at !== null && { finishedAt: r.finished_at }),
  ...(r.duration_seconds !== null && { durationSeconds: r.duration_seconds }),
  ...(r.queued_seconds !== null && { queuedSeconds: r.queued_seconds }),
  allowFailure: r.allow_failure === 1,
  webUrl: r.web_url,
})

/** A `CiJobStore` on the `ci_jobs` table. */
export function sqliteCiJobs(db: Database): CiJobStore {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO ci_jobs (repo_forge, repo_path, job_id, pipeline_id, name, stage, status,
       ref, sha, created_at, started_at, finished_at, duration_seconds, queued_seconds,
       allow_failure, web_url, tag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const put = db.transaction((records: CiJobRecord[]) => {
    for (const record of records.map(normalizeCiJob))
      upsert.run(
        record.repo.forge,
        record.repo.path,
        record.jobId,
        record.pipelineId,
        record.name,
        record.stage,
        record.status,
        record.ref ?? null,
        record.sha ?? null,
        record.createdAt,
        record.startedAt ?? null,
        record.finishedAt ?? null,
        record.durationSeconds ?? null,
        record.queuedSeconds ?? null,
        record.allowFailure ? 1 : 0,
        record.webUrl,
        record.tag ? 1 : 0,
      )
  })
  const list = db.query<CiJobRow, [string, string, string | null, string | null]>(
    `SELECT * FROM ci_jobs
     WHERE repo_forge = ?1 AND repo_path = ?2
       AND (?3 IS NULL OR created_at >= ?3) AND (?4 IS NULL OR created_at < ?4)
     ORDER BY created_at, job_id`,
  )
  const coverage = db.query<
    { oldest: string | null; newest: string | null; jobs: number },
    [string, string]
  >(
    `SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest, COUNT(*) AS jobs
     FROM ci_jobs WHERE repo_forge = ? AND repo_path = ?`,
  )
  const prune = db.prepare('DELETE FROM ci_jobs WHERE created_at < ?')

  return {
    async put(records) {
      put(records)
    },
    async list(repo, { from, to } = {}) {
      return list.all(repo.forge, repo.path, from ?? null, to ?? null).map(toRecord)
    },
    async coverage(repo) {
      const row = coverage.get(repo.forge, repo.path)
      return row?.oldest && row.newest
        ? { oldest: row.oldest, newest: row.newest, jobs: row.jobs }
        : undefined
    },
    async prune(before) {
      return prune.run(before).changes
    },
  }
}
