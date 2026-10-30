import type { Database, SQLQueryBindings } from 'bun:sqlite'

import { scopeCoversRepo } from '@holtkeeper/access'
import type {
  AiUsageBucket,
  AiUsageDimension,
  AiUsageFilter,
  AiUsageRecord,
  AiUsageStore,
} from '@holtkeeper/store'
import { aggregateFilter, sortAiUsageBuckets } from '@holtkeeper/store'

interface AiUsageRow {
  id: string
  at: string
  repo_forge: string
  repo_path: string
  groups: string
  task_kind: string
  analyzer: string | null
  job_id: string | null
  analysis_id: string | null
  actor: string
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
  cost_source: AiUsageRecord['costSource']
  duration_ms: number
  turns: number
  outcome: AiUsageRecord['outcome']
  error: string | null
}

const toRecord = (r: AiUsageRow): AiUsageRecord => ({
  id: r.id,
  at: r.at,
  repo: { forge: r.repo_forge, path: r.repo_path },
  groups: JSON.parse(r.groups),
  taskKind: r.task_kind,
  ...(r.analyzer !== null && { analyzer: r.analyzer }),
  ...(r.job_id !== null && { jobId: r.job_id }),
  ...(r.analysis_id !== null && { analysisId: r.analysis_id }),
  actor: r.actor,
  provider: r.provider,
  model: r.model,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  costUsd: r.cost_usd,
  costSource: r.cost_source,
  durationMs: r.duration_ms,
  turns: r.turns,
  outcome: r.outcome,
  ...(r.error !== null && { error: r.error }),
})

const day = 'substr(r.at, 1, 10)'

const dimensionSql: Record<AiUsageDimension, string> = {
  day,
  week: `date(${day}, '-' || ((CAST(strftime('%w', ${day}) AS INTEGER) + 6) % 7) || ' days')`,
  month: 'substr(r.at, 1, 7)',
  repo: `r.repo_forge || ':' || r.repo_path`,
  group: `COALESCE(g.value, '')`,
  model: 'r.model',
  provider: 'r.provider',
  taskKind: 'r.task_kind',
  analyzer: `COALESCE(r.analyzer, '')`,
}

const number = (value: string | number | null | undefined) => Number(value ?? 0)

interface Where {
  sql: string
  params: SQLQueryBindings[]
}

/** Every condition of `filter` but `scopes`. */
function plainWhere(filter: AiUsageFilter): Where {
  const conditions: string[] = []
  const params: SQLQueryBindings[] = []
  const add = (condition: string, ...values: SQLQueryBindings[]) => {
    conditions.push(condition)
    params.push(...values)
  }
  if (filter.from !== undefined) add('r.at >= ?', filter.from)
  if (filter.to !== undefined) add('r.at < ?', filter.to)
  if (filter.repo) add('r.repo_forge = ? AND r.repo_path = ?', filter.repo.forge, filter.repo.path)
  if (filter.group !== undefined)
    add('EXISTS (SELECT 1 FROM json_each(r.groups) WHERE value = ?)', filter.group)
  if (filter.model !== undefined) add('r.model = ?', filter.model)
  if (filter.provider !== undefined) add('r.provider = ?', filter.provider)
  if (filter.taskKind !== undefined) add('r.task_kind = ?', filter.taskKind)
  if (filter.analyzer !== undefined) add('r.analyzer = ?', filter.analyzer)
  if (filter.outcome !== undefined) add('r.outcome = ?', filter.outcome)
  return { sql: conditions.length ? conditions.join(' AND ') : '1', params }
}

/**
 * An `AiUsageStore` on the `ai_usage` table. Scope filters cannot be expressed in SQL (they use
 * path globs), so they resolve first to the distinct repositories that pass the other filters.
 */
export function sqliteAiUsage(db: Database): AiUsageStore {
  const insert = db.prepare(
    `INSERT INTO ai_usage (id, at, repo_forge, repo_path, groups, task_kind, analyzer, job_id,
       analysis_id, actor, provider, model, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, cost_usd, cost_source, duration_ms, turns, outcome, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  function where(filter: AiUsageFilter): Where {
    const plain = plainWhere(filter)
    const { scopes } = filter
    if (scopes === undefined || scopes.some((scope) => scope.all)) return plain
    if (!scopes.length) return { sql: '0', params: [] }
    const candidates = db
      .query<{ repo_forge: string; repo_path: string; groups: string }, SQLQueryBindings[]>(
        `SELECT DISTINCT repo_forge, repo_path, groups FROM ai_usage r WHERE ${plain.sql}`,
      )
      .all(...plain.params)
    const allowed = candidates
      .filter((row) =>
        scopes.some((scope) =>
          scopeCoversRepo(scope, {
            forge: row.repo_forge,
            path: row.repo_path,
            groups: JSON.parse(row.groups),
          }),
        ),
      )
      .map((row) => [row.repo_forge, row.repo_path, row.groups])
    return {
      sql: `${plain.sql} AND EXISTS (
        SELECT 1 FROM json_each(?) a
        WHERE json_extract(a.value, '$[0]') = r.repo_forge AND json_extract(a.value, '$[1]') = r.repo_path
          AND json_extract(a.value, '$[2]') = r.groups)`,
      params: [...plain.params, JSON.stringify(allowed)],
    }
  }

  return {
    async append(record) {
      const id = crypto.randomUUID()
      insert.run(
        id,
        record.at,
        record.repo.forge,
        record.repo.path,
        JSON.stringify(record.groups),
        record.taskKind,
        record.analyzer ?? null,
        record.jobId ?? null,
        record.analysisId ?? null,
        record.actor,
        record.provider,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.costUsd,
        record.costSource,
        record.durationMs,
        record.turns,
        record.outcome,
        record.error ?? null,
      )
      return { ...structuredClone(record), id }
    },
    async list({ before, limit = 50, ...filter } = {}) {
      const { sql, params } = where(filter)
      return db
        .query<AiUsageRow, SQLQueryBindings[]>(
          `SELECT * FROM ai_usage r WHERE ${sql} AND (? IS NULL OR r.at < ?)
           ORDER BY r.at DESC, r.seq DESC LIMIT ?`,
        )
        .all(...params, before ?? null, before ?? null, limit)
        .map(toRecord)
    },
    async aggregate(query = {}) {
      const groupBy = query.groupBy ?? []
      const { sql, params } = where(aggregateFilter(query))
      const keys = groupBy.map((dimension, index) => `${dimensionSql[dimension]} AS k${index}`)
      const rows = db
        .query<Record<string, string | number | null>, SQLQueryBindings[]>(
          `SELECT ${[...keys, ''].join(', ')}
             SUM(r.input_tokens) AS inputTokens, SUM(r.output_tokens) AS outputTokens,
             SUM(r.cache_read_tokens) AS cacheReadTokens, SUM(r.cache_write_tokens) AS cacheWriteTokens,
             SUM(r.cost_usd) AS costUsd, COUNT(*) AS runs,
             SUM(r.outcome = 'error') AS errors, SUM(r.outcome = 'denied-budget') AS denied,
             AVG(CASE WHEN r.outcome != 'denied-budget' THEN r.duration_ms END) AS avgDurationMs
           FROM ai_usage r ${groupBy.includes('group') ? 'LEFT JOIN json_each(r.groups) g' : ''}
           WHERE ${sql}
           ${groupBy.length ? `GROUP BY ${groupBy.map((_, index) => `k${index}`).join(', ')}` : ''}
           HAVING COUNT(*) > 0`,
        )
        .all(...params)
      const buckets = rows.map((row): AiUsageBucket => ({
        key: Object.fromEntries(
          groupBy.map((dimension, index) => [dimension, String(row[`k${index}`])]),
        ),
        inputTokens: number(row.inputTokens),
        outputTokens: number(row.outputTokens),
        cacheReadTokens: number(row.cacheReadTokens),
        cacheWriteTokens: number(row.cacheWriteTokens),
        costUsd: number(row.costUsd),
        runs: number(row.runs),
        errors: number(row.errors),
        denied: number(row.denied),
        avgDurationMs: number(row.avgDurationMs),
      }))
      return sortAiUsageBuckets(buckets, groupBy)
    },
  }
}
