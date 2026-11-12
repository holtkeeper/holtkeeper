import type { JobAttempt, JobCountQuery, JobSearch, JobStatus, JobStore } from '@holtkeeper/store'
import {
  claimDueBy,
  DEFAULT_MAX_ATTEMPTS,
  errorSignature,
  jobCounts,
  likeText,
  STALE_JOB_ERROR,
} from '@holtkeeper/store'
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

type AttemptPatch = Omit<Partial<JobAttempt>, 'n' | 'startedAt'>

/** `attempts_history` with `patch` merged into its last attempt while that one is running. */
const endAttempt = (sql: SQL, patch: AttemptPatch) => sql`
  CASE WHEN attempts_history -> -1 ->> 'status' = 'running'
    THEN jsonb_set(attempts_history, ARRAY[(jsonb_array_length(attempts_history) - 1)::text],
      (attempts_history -> -1) || jsonb_strip_nulls(${sql.json(patch)}::jsonb))
    ELSE attempts_history END`

/** `repos` as the JSON list `inRepos` compares with, or `null` for any. */
const repoList = (repos: { forge: string; path: string }[] | undefined) =>
  repos === undefined ? null : repos.map((repo) => [repo.forge, repo.path])

const inRepos = (sql: SQL, repos: { forge: string; path: string }[] | undefined) => {
  const list = repoList(repos)
  return sql`(${list === null ? null : sql.json(list)}::jsonb IS NULL
    OR jsonb_build_array(repo_forge, repo_path) IN (
      SELECT jsonb_array_elements(${list === null ? null : sql.json(list)}::jsonb)))`
}

const matchesSearch = (sql: SQL, search: JobSearch | undefined) => {
  const text = search ? likeText(search.text) : null
  return sql`(${text}::text IS NULL OR lower(id) LIKE ${text}::text || '%'
    OR lower(repo_path) LIKE '%' || ${text}::text || '%'
    OR lower(coalesce(group_name, '')) LIKE '%' || ${text}::text || '%'
    OR lower(analyzer) LIKE '%' || ${text}::text || '%'
    OR analyzer IN (SELECT jsonb_array_elements_text(${sql.json(search?.analyzers ?? [])}::jsonb)))`
}

/** Every condition of a job query but paging and `since`, as one SQL fragment. */
const jobWhere = (sql: SQL, query: JobCountQuery) => {
  const { status, repo, analyzer, schedule, trigger, repos, analysisId } = query
  const signature = query.errorSignature ?? null
  const statuses = statusList(status)
  return sql`(${statuses === null ? null : sql.json(statuses)}::jsonb IS NULL
      OR status IN (SELECT jsonb_array_elements_text(${statuses === null ? null : sql.json(statuses)}::jsonb)))
    AND (${repo?.forge ?? null}::text IS NULL
      OR (repo_forge = ${repo?.forge ?? null}::text AND repo_path = ${repo?.path ?? null}::text))
    AND (${analyzer ?? null}::text IS NULL OR analyzer = ${analyzer ?? null}::text)
    AND (${schedule ?? null}::text IS NULL OR schedule = ${schedule ?? null}::text)
    AND (${trigger ?? null}::text IS NULL OR trigger = ${trigger ?? null}::text)
    AND (${signature}::text IS NULL OR error_signature = ${signature}::text)
    AND (${analysisId ?? null}::text IS NULL OR analysis_id = ${analysisId ?? null}::text)
    AND ${inRepos(sql, repos)}
    AND ${matchesSearch(sql, query.search)}`
}

interface FailureRow {
  analyzer: string
  error_signature: string
  count: number | string
  repos: number | string
  first_at: Date | string
  last_at: Date | string
  latest_id: string
  error: string | null
}

const isoOf = (value: Date | string) =>
  (value instanceof Date ? value : new Date(value)).toISOString()

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
          status, attempts, max_attempts, run_after, created_at, actor, schedule, reason)
        VALUES (${crypto.randomUUID()}, ${job.analyzer}, ${job.repo.forge}, ${job.repo.path},
          ${job.group ?? null}, ${job.ref ?? null}, ${sql.json(job.options ?? {})}, ${job.trigger},
          'queued', 0, ${job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS}, ${job.runAfter ?? job.createdAt},
          ${job.createdAt}, ${job.actor ?? null}, ${job.schedule ?? null}, ${job.reason ?? null})
        RETURNING *`
      const stored = one(rows)
      if (!stored) throw new Error('job insert returned nothing')
      return stored
    },
    async claim(workerId, now, { exclusive = [], after = {}, delayMs, only, except = [] } = {}) {
      const { sql, t } = await db()
      const dueBy = claimDueBy(now, delayMs)
      const startable = () => sql`
        (${only === undefined}::boolean
          OR j.analyzer IN (SELECT jsonb_array_elements_text(${sql.json(only ?? [])}::jsonb)))
        AND j.analyzer NOT IN (SELECT jsonb_array_elements_text(${sql.json(except)}::jsonb))
        AND NOT EXISTS (
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
              WHERE j.status = 'queued' AND j.run_after <= ${dueBy}::timestamptz AND ${startable()}
              ORDER BY j.run_after, j.seq
              LIMIT 1
              FOR UPDATE SKIP LOCKED`
            if (!next) return undefined
            const key = claimLockKey({ forge: next.repo_forge, path: next.repo_path })
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
            const rows: JobRow[] = await tx`
              UPDATE ${t.jobs} AS j SET status = 'running', attempts = j.attempts + 1,
                worker_id = ${workerId}, started_at = ${now}::timestamptz,
                heartbeat_at = ${now}::timestamptz, finished_at = NULL,
                attempts_history = j.attempts_history || jsonb_build_array(jsonb_build_object(
                  'n', j.attempts + 1, 'status', 'running', 'startedAt', ${now}::text,
                  'workerId', ${workerId}::text))
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
            error_signature = NULL,
            attempts_history = ${endAttempt(sql, { status: 'succeeded', finishedAt: at })},
            analysis_id = COALESCE(${analysisId ?? null}::text, analysis_id)
          WHERE id = ${id} AND status = 'running'
          RETURNING *`,
      )
    },
    async fail(id, { at, error, retryAt, step }) {
      const { sql, t } = await db()
      const retry = () =>
        sql`(${retryAt ?? null}::timestamptz IS NOT NULL AND attempts < max_attempts)`
      const attempt = endAttempt(sql, { status: 'failed', finishedAt: at, error, step })
      return one(
        await sql`
          UPDATE ${t.jobs} SET error = ${error}, error_signature = ${errorSignature(error)},
            attempts_history = ${attempt},
            status = CASE WHEN ${retry()} THEN 'queued' ELSE 'failed' END,
            run_after = CASE WHEN ${retry()} THEN ${retryAt ?? null}::timestamptz ELSE run_after END,
            worker_id = CASE WHEN ${retry()} THEN NULL ELSE worker_id END,
            finished_at = CASE WHEN ${retry()} THEN finished_at ELSE ${at}::timestamptz END
          WHERE id = ${id} AND status = 'running'
          RETURNING *`,
      )
    },
    async block(id, { at, error }) {
      const { sql, t } = await db()
      return one(
        await sql`
          UPDATE ${t.jobs} SET status = 'blocked', finished_at = ${at}::timestamptz, error = ${error},
            error_signature = NULL,
            attempts_history = ${endAttempt(sql, { status: 'blocked', finishedAt: at, error })}
          WHERE id = ${id} AND status = 'running'
          RETURNING *`,
      )
    },
    async cancel(id, at) {
      const { sql, t } = await db()
      const changed: JobRow[] = await sql`
        UPDATE ${t.jobs} SET status = 'canceled', finished_at = ${at}::timestamptz,
          attempts_history = ${endAttempt(sql, { status: 'canceled', finishedAt: at })}
        WHERE id = ${id} AND status IN ('queued', 'running')
        RETURNING *`
      return one(changed.length ? changed : await sql`SELECT * FROM ${t.jobs} WHERE id = ${id}`)
    },
    async recoverStale(heartbeatBefore, at) {
      const { sql, t } = await db()
      const rows: JobRow[] = await sql`
        UPDATE ${t.jobs} SET error = ${STALE_JOB_ERROR},
          error_signature = ${errorSignature(STALE_JOB_ERROR)},
          attempts_history = ${endAttempt(sql, { status: 'failed', finishedAt: at, error: STALE_JOB_ERROR })},
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
    async list(query = {}) {
      const { before, limit = 50 } = query
      const { sql, t } = await db()
      const rows: JobRow[] = await sql`
        SELECT * FROM ${t.jobs}
        WHERE ${jobWhere(sql, query)}
          AND (${before ?? null}::timestamptz IS NULL OR created_at < ${before ?? null}::timestamptz)
        ORDER BY created_at DESC, seq DESC LIMIT ${limit}`
      return rows.map(toJob)
    },
    async count(query = {}) {
      const { since } = query
      const { sql, t } = await db()
      const rows: { status: JobStatus; count: number | string }[] = await sql`
        SELECT status, count(*) AS count FROM ${t.jobs}
        WHERE ${jobWhere(sql, query)}
          AND (${since ?? null}::timestamptz IS NULL OR created_at >= ${since ?? null}::timestamptz)
        GROUP BY status`
      return jobCounts(rows.map((row) => [row.status, Number(row.count)] as const))
    },
    async failures({ since, analyzer, repos, limit = 50 }) {
      const { sql, t } = await db()
      const rows: FailureRow[] = await sql`
        SELECT analyzer, error_signature, count(*) AS count,
          count(DISTINCT (repo_forge, repo_path)) AS repos,
          min(finished_at) AS first_at, max(finished_at) AS last_at,
          (array_agg(id ORDER BY finished_at DESC, seq DESC))[1] AS latest_id,
          (array_agg(error ORDER BY finished_at DESC, seq DESC))[1] AS error
        FROM ${t.jobs}
        WHERE status = 'failed' AND error_signature IS NOT NULL
          AND finished_at >= ${since}::timestamptz
          AND (${analyzer ?? null}::text IS NULL OR analyzer = ${analyzer ?? null}::text)
          AND ${inRepos(sql, repos)}
        GROUP BY analyzer, error_signature
        ORDER BY last_at DESC LIMIT ${limit}`
      return rows.map((row) => ({
        analyzer: row.analyzer,
        errorSignature: row.error_signature,
        count: Number(row.count),
        repos: Number(row.repos),
        firstAt: isoOf(row.first_at),
        lastAt: isoOf(row.last_at),
        latestJobId: row.latest_id,
        error: row.error ?? '',
      }))
    },
    async targets() {
      const { sql, t } = await db()
      const rows: { repo_forge: string; repo_path: string; group_name: string | null }[] =
        await sql`SELECT DISTINCT repo_forge, repo_path, group_name FROM ${t.jobs}`
      return rows.map((row) => ({
        repo: { forge: row.repo_forge, path: row.repo_path },
        ...(row.group_name !== null && { group: row.group_name }),
      }))
    },
  }
}
