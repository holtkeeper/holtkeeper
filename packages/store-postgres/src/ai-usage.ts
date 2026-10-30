import { scopeCoversRepo } from '@holtkeeper/access'
import type {
  AiUsageBucket,
  AiUsageDimension,
  AiUsageFilter,
  AiUsageStore,
} from '@holtkeeper/store'
import { aggregateFilter, sortAiUsageBuckets } from '@holtkeeper/store'
import type { SQL } from 'bun'

import { type AiUsageRow, num, toAiUsage } from './rows.ts'
import type { Db, Tables } from './tables.ts'

/** Which dimensions a grouping uses, as the boolean parameters of the aggregate query. */
export function dimensionFlags(
  groupBy: readonly AiUsageDimension[] = [],
): Record<AiUsageDimension, boolean> {
  const on = (dimension: AiUsageDimension) => groupBy.includes(dimension)
  return {
    day: on('day'),
    week: on('week'),
    month: on('month'),
    repo: on('repo'),
    group: on('group'),
    model: on('model'),
    provider: on('provider'),
    taskKind: on('taskKind'),
    analyzer: on('analyzer'),
  }
}

/** A (forge, path, groups) triple a scope filter lets through, as compared in SQL. */
export type AllowedRepo = [forge: string, path: string, groups: string[]]

/** The triples of `candidates` that at least one of `scopes` covers. */
export function coveredRepos(
  candidates: readonly AllowedRepo[],
  scopes: NonNullable<AiUsageFilter['scopes']>,
): AllowedRepo[] {
  return candidates.filter(([forge, path, groups]) =>
    scopes.some((scope) => scopeCoversRepo(scope, { forge, path, groups })),
  )
}

export interface AggregateRow {
  k_day: string
  k_week: string
  k_month: string
  k_repo: string
  k_group: string
  k_model: string
  k_provider: string
  k_task_kind: string
  k_analyzer: string
  input_tokens: number | string | null
  output_tokens: number | string | null
  cache_read_tokens: number | string | null
  cache_write_tokens: number | string | null
  cost_usd: number | string | null
  runs: number | string
  errors: number | string
  denied: number | string
  avg_duration_ms: number | string | null
}

const keyColumn: Record<AiUsageDimension, keyof AggregateRow> = {
  day: 'k_day',
  week: 'k_week',
  month: 'k_month',
  repo: 'k_repo',
  group: 'k_group',
  model: 'k_model',
  provider: 'k_provider',
  taskKind: 'k_task_kind',
  analyzer: 'k_analyzer',
}

/** One aggregate row as a bucket keyed by the requested dimensions only. */
export function toBucket(row: AggregateRow, groupBy: readonly AiUsageDimension[]): AiUsageBucket {
  return {
    key: Object.fromEntries(
      groupBy.map((dimension) => [dimension, String(row[keyColumn[dimension]] ?? '')]),
    ),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    cacheReadTokens: num(row.cache_read_tokens),
    cacheWriteTokens: num(row.cache_write_tokens),
    costUsd: num(row.cost_usd),
    runs: num(row.runs),
    errors: num(row.errors),
    denied: num(row.denied),
    avgDurationMs: num(row.avg_duration_ms),
  }
}

/** Every condition of an AI usage filter but `scopes`, over rows aliased `r`. */
const plainWhere = (sql: SQL, f: AiUsageFilter) => sql`
  (${f.from ?? null}::timestamptz IS NULL OR r.at >= ${f.from ?? null}::timestamptz)
  AND (${f.to ?? null}::timestamptz IS NULL OR r.at < ${f.to ?? null}::timestamptz)
  AND (${f.repo?.forge ?? null}::text IS NULL
    OR (r.repo_forge = ${f.repo?.forge ?? null}::text AND r.repo_path = ${f.repo?.path ?? null}::text))
  AND (${f.group ?? null}::text IS NULL OR r.groups @> jsonb_build_array(${f.group ?? null}::text))
  AND (${f.model ?? null}::text IS NULL OR r.model = ${f.model ?? null}::text)
  AND (${f.provider ?? null}::text IS NULL OR r.provider = ${f.provider ?? null}::text)
  AND (${f.taskKind ?? null}::text IS NULL OR r.task_kind = ${f.taskKind ?? null}::text)
  AND (${f.analyzer ?? null}::text IS NULL OR r.analyzer = ${f.analyzer ?? null}::text)
  AND (${f.outcome ?? null}::text IS NULL OR r.outcome = ${f.outcome ?? null}::text)`

// A fragment is thenable, so the async helper wraps it in an array (which Bun joins) to keep the
// promise from running it as a query of its own.
async function where(sql: SQL, t: Tables, filter: AiUsageFilter): Promise<SQL.Query<unknown>[]> {
  const plain = plainWhere(sql, filter)
  const { scopes } = filter
  if (scopes === undefined || scopes.some((scope) => scope.all)) return [plain]
  let allowed: AllowedRepo[] = []
  if (scopes.length) {
    const candidates: { repo_forge: string; repo_path: string; groups: string[] }[] = await sql`
      SELECT DISTINCT r.repo_forge, r.repo_path, r.groups FROM ${t.aiUsage} r
      WHERE ${plainWhere(sql, filter)}`
    allowed = coveredRepos(
      candidates.map((row) => [row.repo_forge, row.repo_path, row.groups]),
      scopes,
    )
  }
  return [
    sql`${plain} AND jsonb_build_array(r.repo_forge, r.repo_path, r.groups)
      IN (SELECT jsonb_array_elements(${sql.json(allowed)}::jsonb))`,
  ]
}

/**
 * An `AiUsageStore` on the `ai_usage` table. Every query is static: unused filters are `NULL`
 * parameters and unused dimensions collapse to `''`, so one prepared statement serves every
 * grouping. Scope filters use path globs that SQL cannot match the way `scopeCoversRepo` does, so
 * they first resolve to the covered (repository, groups) pairs among those passing the other
 * filters.
 */
export function postgresAiUsage(db: () => Promise<Db>): AiUsageStore {
  return {
    async append(record) {
      const { sql, t } = await db()
      const [row]: AiUsageRow[] = await sql`
        INSERT INTO ${t.aiUsage} (id, at, repo_forge, repo_path, groups, task_kind, analyzer, job_id,
          analysis_id, actor, provider, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost_usd, cost_source, duration_ms, turns, outcome, error)
        VALUES (${crypto.randomUUID()}, ${record.at}, ${record.repo.forge}, ${record.repo.path},
          ${sql.json(record.groups)}, ${record.taskKind}, ${record.analyzer ?? null},
          ${record.jobId ?? null}, ${record.analysisId ?? null}, ${record.actor},
          ${record.provider}, ${record.model}, ${record.inputTokens}, ${record.outputTokens},
          ${record.cacheReadTokens}, ${record.cacheWriteTokens}, ${record.costUsd}::float8,
          ${record.costSource}, ${record.durationMs}, ${record.turns}, ${record.outcome},
          ${record.error ?? null})
        RETURNING *`
      if (!row) throw new Error('insert returned no row')
      return toAiUsage(row)
    },
    async list({ before, limit = 50, ...filter } = {}) {
      const { sql, t } = await db()
      const rows: AiUsageRow[] = await sql`
        SELECT * FROM ${t.aiUsage} r
        WHERE ${await where(sql, t, filter)}
          AND (${before ?? null}::timestamptz IS NULL OR r.at < ${before ?? null}::timestamptz)
        ORDER BY r.at DESC, r.seq DESC LIMIT ${limit}`
      return rows.map(toAiUsage)
    },
    async aggregate(query = {}) {
      const { sql, t } = await db()
      const groupBy = query.groupBy ?? []
      const on = dimensionFlags(groupBy)
      const rows: AggregateRow[] = await sql`
        SELECT
          CASE WHEN ${on.day}::boolean THEN to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') ELSE '' END AS k_day,
          CASE WHEN ${on.week}::boolean
            THEN to_char(date_trunc('week', r.at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') ELSE '' END AS k_week,
          CASE WHEN ${on.month}::boolean THEN to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM') ELSE '' END AS k_month,
          CASE WHEN ${on.repo}::boolean THEN r.repo_forge || ':' || r.repo_path ELSE '' END AS k_repo,
          g.name AS k_group,
          CASE WHEN ${on.model}::boolean THEN r.model ELSE '' END AS k_model,
          CASE WHEN ${on.provider}::boolean THEN r.provider ELSE '' END AS k_provider,
          CASE WHEN ${on.taskKind}::boolean THEN r.task_kind ELSE '' END AS k_task_kind,
          CASE WHEN ${on.analyzer}::boolean THEN COALESCE(r.analyzer, '') ELSE '' END AS k_analyzer,
          SUM(r.input_tokens) AS input_tokens,
          SUM(r.output_tokens) AS output_tokens,
          SUM(r.cache_read_tokens) AS cache_read_tokens,
          SUM(r.cache_write_tokens) AS cache_write_tokens,
          SUM(r.cost_usd) AS cost_usd,
          COUNT(*)::int AS runs,
          (COUNT(*) FILTER (WHERE r.outcome = 'error'))::int AS errors,
          (COUNT(*) FILTER (WHERE r.outcome = 'denied-budget'))::int AS denied,
          (AVG(r.duration_ms) FILTER (WHERE r.outcome <> 'denied-budget'))::float8 AS avg_duration_ms
        FROM ${t.aiUsage} r
        CROSS JOIN LATERAL (
          SELECT value AS name FROM jsonb_array_elements_text(r.groups) WHERE ${on.group}::boolean
          UNION ALL
          SELECT '' WHERE NOT ${on.group}::boolean OR jsonb_array_length(r.groups) = 0
        ) g
        WHERE ${await where(sql, t, aggregateFilter(query))}
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`
      return sortAiUsageBuckets(
        rows.map((row) => toBucket(row, groupBy)),
        groupBy,
      )
    },
  }
}
