import type { JobStore } from '@holtkeeper/store'
import { DEFAULT_MAX_ATTEMPTS, JOB_LOG_LIMIT } from '@holtkeeper/store'
import { SQL } from 'bun'

import { type JobRow, toJob } from './rows.ts'
import type { Db } from './tables.ts'

/** How often `claim` retries after losing a race for a repository to another worker. */
const CLAIM_RETRIES = 5

/** Whether `error` is the server rejecting a row that breaks a unique index. */
export const isUniqueViolation = (error: unknown) =>
  error instanceof SQL.PostgresError && error.errno === '23505'

/** `status` of a job query as the JSON list the SQL compares with, or `null` for any. */
export const statusList = (status: string | string[] | undefined) =>
  status === undefined ? null : [status].flat()

/**
 * The Postgres `JobStore`. `claim` is one statement that locks the oldest due job with
 * `FOR UPDATE SKIP LOCKED`, so concurrent workers never wait on or take the same row. The partial
 * unique index `jobs_one_running_per_repo` makes "one running job per repository" hold even when
 * two workers pick different jobs of one repository at the same moment: the later commit fails,
 * and `claim` retries with fresh data.
 */
const one = (rows: JobRow[]) => (rows[0] ? toJob(rows[0]) : undefined)

export function postgresJobs(db: () => Promise<Db>): JobStore {
  return {
    async enqueue(job) {
      const { sql, t } = await db()
      const rows: JobRow[] = await sql`
        INSERT INTO ${t.jobs} (id, analyzer, repo_forge, repo_path, group_name, ref, options, trigger,
          status, attempts, max_attempts, run_after, created_at, log, actor)
        VALUES (${crypto.randomUUID()}, ${job.analyzer}, ${job.repo.forge}, ${job.repo.path},
          ${job.group ?? null}, ${job.ref ?? null}, ${sql.json(job.options ?? {})}, ${job.trigger},
          'queued', 0, ${job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS}, ${job.runAfter ?? job.createdAt},
          ${job.createdAt}, '[]', ${job.actor ?? null})
        RETURNING *`
      const stored = one(rows)
      if (!stored) throw new Error('job insert returned nothing')
      return stored
    },
    async claim(workerId, now) {
      const { sql, t } = await db()
      for (let attempt = 0; ; attempt++) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- a retry runs only after the previous attempt lost a race
          const rows: JobRow[] = await sql`
            WITH next AS (
              SELECT j.seq FROM ${t.jobs} j
              WHERE j.status = 'queued' AND j.run_after <= ${now}::timestamptz
                AND NOT EXISTS (
                  SELECT 1 FROM ${t.jobs} r
                  WHERE r.status = 'running' AND r.repo_forge = j.repo_forge AND r.repo_path = j.repo_path
                )
              ORDER BY j.run_after, j.seq
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            )
            UPDATE ${t.jobs} AS u SET status = 'running', attempts = u.attempts + 1,
              worker_id = ${workerId}, started_at = ${now}::timestamptz,
              heartbeat_at = ${now}::timestamptz, finished_at = NULL
            FROM next WHERE u.seq = next.seq
            RETURNING u.*`
          return one(rows)
        } catch (error) {
          if (!isUniqueViolation(error) || attempt >= CLAIM_RETRIES) throw error
        }
      }
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
    async list({ status, repo, analyzer, before, limit = 50 } = {}) {
      const { sql, t } = await db()
      const statuses = statusList(status)
      const rows: JobRow[] = await sql`
        SELECT * FROM ${t.jobs}
        WHERE (${statuses === null ? null : sql.json(statuses)}::jsonb IS NULL
            OR status IN (SELECT jsonb_array_elements_text(${statuses === null ? null : sql.json(statuses)}::jsonb)))
          AND (${repo?.forge ?? null}::text IS NULL
            OR (repo_forge = ${repo?.forge ?? null}::text AND repo_path = ${repo?.path ?? null}::text))
          AND (${analyzer ?? null}::text IS NULL OR analyzer = ${analyzer ?? null}::text)
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
