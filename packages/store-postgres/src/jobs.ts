import type { JobStore } from '@holtkeeper/store'
import { DEFAULT_MAX_ATTEMPTS, JOB_LOG_LIMIT } from '@holtkeeper/store'
import { SQL } from 'bun'

import { type JobRow, toJob } from './rows.ts'
import type { Db } from './tables.ts'

/** How often `claim` picks a new job after another worker started a conflicting one first. */
const CLAIM_RETRIES = 5

/** The key `pg_advisory_xact_lock` takes while starting a job of one repository. */
const claimLockKey = (repo: { forge: string; path: string }) =>
  `holtkeeper.claim:${repo.forge}:${repo.path}`

class ClaimConflict extends Error {}

/** Whether `error` is the server rejecting a row that breaks a unique index. */
export const isUniqueViolation = (error: unknown) =>
  error instanceof SQL.PostgresError && error.errno === '23505'

/** `status` of a job query as the JSON list the SQL compares with, or `null` for any. */
export const statusList = (status: string | string[] | undefined) =>
  status === undefined ? null : [status].flat()

const one = (rows: JobRow[]) => (rows[0] ? toJob(rows[0]) : undefined)

/**
 * The Postgres `JobStore`. `claim` locks the first job that may start with `FOR UPDATE SKIP LOCKED`,
 * so concurrent workers never wait on or take the same row, then takes a transaction-level
 * advisory lock on the job's repository and starts the job only if it still may start. Workers
 * starting jobs of one repository serialize on that lock and each sees what the previous one
 * started, so the claim rules hold across processes; a worker whose job no longer may start rolls
 * back and picks again. The partial unique index `jobs_one_running_per_analyzer` backs the
 * one-running-job-per-analyzer rule.
 */
export function postgresJobs(db: () => Promise<Db>): JobStore {
  return {
    async enqueue(job) {
      const { sql, t } = await db()
      const rows: JobRow[] = await sql`
        INSERT INTO ${t.jobs} (id, analyzer, repo_forge, repo_path, group_name, ref, options, trigger,
          status, attempts, max_attempts, run_after, created_at, log, actor, schedule)
        VALUES (${crypto.randomUUID()}, ${job.analyzer}, ${job.repo.forge}, ${job.repo.path},
          ${job.group ?? null}, ${job.ref ?? null}, ${sql.json(job.options ?? {})}, ${job.trigger},
          'queued', 0, ${job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS}, ${job.runAfter ?? job.createdAt},
          ${job.createdAt}, '[]', ${job.actor ?? null}, ${job.schedule ?? null})
        RETURNING *`
      const stored = one(rows)
      if (!stored) throw new Error('job insert returned nothing')
      return stored
    },
    async claim(workerId, now, { exclusive = [], after = {} } = {}) {
      const { sql, t } = await db()
      const startable = () => sql`
        NOT EXISTS (
          SELECT 1 FROM ${t.jobs} r
          WHERE r.status = 'running' AND r.repo_forge = j.repo_forge AND r.repo_path = j.repo_path
            AND (r.analyzer = j.analyzer
              OR j.analyzer IN (SELECT jsonb_array_elements_text(${sql.json(exclusive)}::jsonb)))
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${t.jobs} d
          WHERE d.repo_forge = j.repo_forge AND d.repo_path = j.repo_path
            AND (d.analyzer IN (SELECT jsonb_array_elements_text(${sql.json(exclusive)}::jsonb))
              OR d.analyzer IN (SELECT jsonb_array_elements_text(
                COALESCE(${sql.json(after)}::jsonb -> j.analyzer, '[]'::jsonb))))
            AND (d.status = 'running'
              OR (d.status = 'queued' AND (d.run_after, d.seq) < (j.run_after, j.seq)))
        )`
      for (let attempt = 0; attempt <= CLAIM_RETRIES; attempt++) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- a retry runs only after the previous attempt lost a race
          return await sql.begin(async (tx) => {
            const [next]: { id: string; repo_forge: string; repo_path: string }[] = await tx`
              SELECT j.id, j.repo_forge, j.repo_path FROM ${t.jobs} j
              WHERE j.status = 'queued' AND j.run_after <= ${now}::timestamptz AND ${startable()}
              ORDER BY j.run_after, j.seq
              LIMIT 1
              FOR UPDATE SKIP LOCKED`
            if (!next) return undefined
            const key = claimLockKey({ forge: next.repo_forge, path: next.repo_path })
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
            const rows: JobRow[] = await tx`
              UPDATE ${t.jobs} AS j SET status = 'running', attempts = j.attempts + 1,
                worker_id = ${workerId}, started_at = ${now}::timestamptz,
                heartbeat_at = ${now}::timestamptz, finished_at = NULL
              WHERE j.id = ${next.id} AND j.status = 'queued' AND ${startable()}
              RETURNING j.*`
            const claimed = one(rows)
            if (!claimed) throw new ClaimConflict()
            return claimed
          })
        } catch (error) {
          if (!(error instanceof ClaimConflict)) throw error
        }
      }
      return undefined
    },
    async heartbeat(id, workerId, now) {
      const { sql, t } = await db()
      const rows: unknown[] = await sql`
        UPDATE ${t.jobs} SET heartbeat_at = ${now}::timestamptz
        WHERE id = ${id} AND worker_id = ${workerId} AND status = 'running'
        RETURNING id`
      return rows.length > 0
    },
    async complete(id, { at, analysisId }) {
      const { sql, t } = await db()
      return one(
        await sql`
          UPDATE ${t.jobs} SET status = 'succeeded', finished_at = ${at}::timestamptz, error = NULL,
            analysis_id = COALESCE(${analysisId ?? null}::text, analysis_id)
          WHERE id = ${id} AND status = 'running'
          RETURNING *`,
      )
    },
    async fail(id, { at, error, retryAt }) {
      const { sql, t } = await db()
      const retry = () =>
        sql`(${retryAt ?? null}::timestamptz IS NOT NULL AND attempts < max_attempts)`
      return one(
        await sql`
          UPDATE ${t.jobs} SET error = ${error},
            status = CASE WHEN ${retry()} THEN 'queued' ELSE 'failed' END,
            run_after = CASE WHEN ${retry()} THEN ${retryAt ?? null}::timestamptz ELSE run_after END,
            worker_id = CASE WHEN ${retry()} THEN NULL ELSE worker_id END,
            finished_at = CASE WHEN ${retry()} THEN finished_at ELSE ${at}::timestamptz END
          WHERE id = ${id} AND status = 'running'
          RETURNING *`,
      )
    },
    async cancel(id, at) {
      const { sql, t } = await db()
      const changed: JobRow[] = await sql`
        UPDATE ${t.jobs} SET status = 'canceled', finished_at = ${at}::timestamptz
        WHERE id = ${id} AND status IN ('queued', 'running')
        RETURNING *`
      return one(changed.length ? changed : await sql`SELECT * FROM ${t.jobs} WHERE id = ${id}`)
    },
    async recoverStale(heartbeatBefore, at) {
      const { sql, t } = await db()
      const rows: JobRow[] = await sql`
        UPDATE ${t.jobs} SET error = 'worker stopped responding',
          status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
          run_after = CASE WHEN attempts < max_attempts THEN ${at}::timestamptz ELSE run_after END,
          worker_id = CASE WHEN attempts < max_attempts THEN NULL ELSE worker_id END,
          finished_at = CASE WHEN attempts < max_attempts THEN finished_at ELSE ${at}::timestamptz END
        WHERE status = 'running'
          AND (heartbeat_at IS NULL OR heartbeat_at < ${heartbeatBefore}::timestamptz)
        RETURNING *`
      return rows.map(toJob)
    },
    async get(id) {
      const { sql, t } = await db()
      return one(await sql`SELECT * FROM ${t.jobs} WHERE id = ${id}`)
    },
    async list({ status, repo, analyzer, schedule, before, limit = 50 } = {}) {
      const { sql, t } = await db()
      const statuses = statusList(status)
      const rows: JobRow[] = await sql`
        SELECT * FROM ${t.jobs}
        WHERE (${statuses === null ? null : sql.json(statuses)}::jsonb IS NULL
            OR status IN (SELECT jsonb_array_elements_text(${statuses === null ? null : sql.json(statuses)}::jsonb)))
          AND (${repo?.forge ?? null}::text IS NULL
            OR (repo_forge = ${repo?.forge ?? null}::text AND repo_path = ${repo?.path ?? null}::text))
          AND (${analyzer ?? null}::text IS NULL OR analyzer = ${analyzer ?? null}::text)
          AND (${schedule ?? null}::text IS NULL OR schedule = ${schedule ?? null}::text)
          AND (${before ?? null}::timestamptz IS NULL OR created_at < ${before ?? null}::timestamptz)
        ORDER BY created_at DESC, seq DESC LIMIT ${limit}`
      return rows.map(toJob)
    },
    async appendLog(id, lines) {
      const { sql, t } = await db()
      await sql`
        UPDATE ${t.jobs} AS j SET log = (
          SELECT COALESCE(jsonb_agg(tail.value ORDER BY tail.ord), '[]'::jsonb)
          FROM (
            SELECT e.value, e.ord
            FROM jsonb_array_elements(j.log || ${sql.json(lines)}::jsonb) WITH ORDINALITY AS e (value, ord)
            ORDER BY e.ord DESC LIMIT ${JOB_LOG_LIMIT}
          ) tail
        )
        WHERE j.id = ${id}`
    },
  }
}
