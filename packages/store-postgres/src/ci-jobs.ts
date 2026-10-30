import type { CiJobRecord, CiJobStore } from '@holtkeeper/store'
import { normalizeCiJob } from '@holtkeeper/store'

import { type PgTimestamp, iso, num } from './rows.ts'
import type { Db } from './tables.ts'

interface CiJobRow {
  repo_forge: string
  repo_path: string
  job_id: number | string
  pipeline_id: number | string
  name: string
  stage: string
  status: CiJobRecord['status']
  ref: string | null
  sha: string | null
  tag: boolean
  created_at: PgTimestamp
  started_at: PgTimestamp | null
  finished_at: PgTimestamp | null
  duration_seconds: number | null
  queued_seconds: number | null
  allow_failure: boolean
  web_url: string
}

const toRecord = (r: CiJobRow): CiJobRecord => ({
  repo: { forge: r.repo_forge, path: r.repo_path },
  jobId: num(r.job_id),
  pipelineId: num(r.pipeline_id),
  name: r.name,
  stage: r.stage,
  status: r.status,
  ...(r.ref !== null && { ref: r.ref }),
  ...(r.sha !== null && { sha: r.sha }),
  ...(r.tag && { tag: true }),
  createdAt: iso(r.created_at),
  ...(r.started_at !== null && { startedAt: iso(r.started_at) }),
  ...(r.finished_at !== null && { finishedAt: iso(r.finished_at) }),
  ...(r.duration_seconds !== null && { durationSeconds: r.duration_seconds }),
  ...(r.queued_seconds !== null && { queuedSeconds: r.queued_seconds }),
  allowFailure: r.allow_failure,
  webUrl: r.web_url,
})

const toRow = (record: CiJobRecord) => ({
  repo_forge: record.repo.forge,
  repo_path: record.repo.path,
  job_id: record.jobId,
  pipeline_id: record.pipelineId,
  name: record.name,
  stage: record.stage,
  status: record.status,
  ref: record.ref ?? null,
  sha: record.sha ?? null,
  tag: record.tag ?? false,
  created_at: record.createdAt,
  started_at: record.startedAt ?? null,
  finished_at: record.finishedAt ?? null,
  duration_seconds: record.durationSeconds ?? null,
  queued_seconds: record.queuedSeconds ?? null,
  allow_failure: record.allowFailure,
  web_url: record.webUrl,
})

/** Rows per insert statement, well under Postgres' 65,535 parameters. */
const BATCH = 1000

/** A `CiJobStore` on the `ci_jobs` table. */
export function postgresCiJobs(db: () => Promise<Db>): CiJobStore {
  return {
    async put(records) {
      if (!records.length) return
      const { sql, t } = await db()
      const latest = new Map<string, CiJobRecord>()
      for (const record of records.map(normalizeCiJob))
        latest.set(`${record.repo.forge}\u0000${record.repo.path}\u0000${record.jobId}`, record)
      const rows = [...latest.values()].map(toRow)
      await sql.begin(async (tx) => {
        for (let i = 0; i < rows.length; i += BATCH)
          // oxlint-disable-next-line no-await-in-loop -- batches share one transaction
          await tx`
            INSERT INTO ${t.ciJobs} ${tx(rows.slice(i, i + BATCH))}
            ON CONFLICT (repo_forge, repo_path, job_id) DO UPDATE SET
              pipeline_id = EXCLUDED.pipeline_id, name = EXCLUDED.name, stage = EXCLUDED.stage,
              status = EXCLUDED.status, ref = EXCLUDED.ref, sha = EXCLUDED.sha, tag = EXCLUDED.tag,
              created_at = EXCLUDED.created_at, started_at = EXCLUDED.started_at,
              finished_at = EXCLUDED.finished_at, duration_seconds = EXCLUDED.duration_seconds,
              queued_seconds = EXCLUDED.queued_seconds, allow_failure = EXCLUDED.allow_failure,
              web_url = EXCLUDED.web_url`
      })
    },
    async list(repo, { from, to } = {}) {
      const { sql, t } = await db()
      const rows: CiJobRow[] = await sql`
        SELECT * FROM ${t.ciJobs}
        WHERE repo_forge = ${repo.forge} AND repo_path = ${repo.path}
          AND (${from ?? null}::timestamptz IS NULL OR created_at >= ${from ?? null}::timestamptz)
          AND (${to ?? null}::timestamptz IS NULL OR created_at < ${to ?? null}::timestamptz)
        ORDER BY created_at, job_id`
      return rows.map(toRecord)
    },
    async coverage(repo) {
      const { sql, t } = await db()
      const [row]: {
        oldest: PgTimestamp | null
        newest: PgTimestamp | null
        jobs: number | string
      }[] = await sql`
        SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest, COUNT(*) AS jobs
        FROM ${t.ciJobs} WHERE repo_forge = ${repo.forge} AND repo_path = ${repo.path}`
      return row?.oldest && row.newest
        ? { oldest: iso(row.oldest), newest: iso(row.newest), jobs: num(row.jobs) }
        : undefined
    },
    async prune(before) {
      const { sql, t } = await db()
      const result = await sql`DELETE FROM ${t.ciJobs} WHERE created_at < ${before}::timestamptz`
      return result.count
    },
  }
}
