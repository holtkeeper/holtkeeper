import { describe, expect, test } from 'bun:test'

import { SQL } from 'bun'

import { coveredRepos, dimensionFlags, toBucket } from './ai-usage.ts'
import { isUniqueViolation, statusList } from './jobs.ts'
import { checkSchemaName, migrationLockKey, migrations, pendingMigrations } from './migrations.ts'
import { RANK_WEIGHTS, searchTerms } from './search.ts'

describe('query building', () => {
  test('search terms are distinct lowercase words without operators or quotes', () => {
    expect(searchTerms('React "migr* AND react NEAR(x)')).toEqual([
      'react',
      'migr',
      'and',
      'near',
      'x',
    ])
    expect(searchTerms(`'' :* & | ! <-> \\`)).toEqual([])
    expect(searchTerms('   ')).toEqual([])
  })

  test('rank weights put A over B over C over D', () => {
    const [d, c, b, a] = RANK_WEIGHTS
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
    expect(c).toBeGreaterThan(d)
  })

  test('dimension flags mark only requested dimensions', () => {
    const flags = dimensionFlags(['week', 'team'])
    expect(
      Object.entries(flags)
        .filter(([, on]) => on)
        .map(([d]) => d),
    ).toEqual(['week', 'team'])
    expect(Object.values(dimensionFlags()).some(Boolean)).toBeFalse()
  })

  test('aggregate rows become buckets keyed by the requested dimensions only', () => {
    const bucket = toBucket(
      {
        k_day: '',
        k_week: '2026-10-05',
        k_month: '',
        k_repo: '',
        k_team: 'games',
        k_model: '',
        k_provider: '',
        k_task_kind: '',
        k_analyzer: '',
        k_origin: '',
        input_tokens: '300',
        output_tokens: '60',
        cache_read_tokens: null,
        cache_write_tokens: '0',
        cost_usd: 0.45,
        runs: 4,
        errors: 1,
        denied: 1,
        unknown_cost: '2',
        avg_duration_ms: null,
      },
      ['week', 'team'],
    )
    expect(bucket).toEqual({
      key: { week: '2026-10-05', team: 'games' },
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.45,
      runs: 4,
      errors: 1,
      denied: 1,
      unknownCost: 2,
      avgDurationMs: 0,
    })
  })

  test('scope filters keep only covered repositories', () => {
    expect(
      coveredRepos(
        [
          ['work', 'games/app', ['games']],
          ['work', 'tools/cli', ['tools']],
        ],
        [{ teams: ['tools'] }],
      ),
    ).toEqual([['work', 'tools/cli', ['tools']]])
    expect(coveredRepos([['work', 'games/app', []]], [])).toEqual([])
  })

  test('job status lists', () => {
    expect(statusList(undefined)).toBeNull()
    expect(statusList('queued')).toEqual(['queued'])
    expect(statusList(['queued', 'running'])).toEqual(['queued', 'running'])
    expect(isUniqueViolation(new Error('x'))).toBeFalse()
    expect(
      isUniqueViolation(
        new SQL.PostgresError('dup', { code: 'ERR_POSTGRES_SERVER_ERROR', errno: '23505' }),
      ),
    ).toBeTrue()
  })
})

describe('migrations', () => {
  test('versions are unique and ascending', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions).toEqual([...new Set(versions)].toSorted((a, b) => a - b))
  })

  test('pending steps are the unapplied ones in version order', () => {
    const steps = [3, 1, 2].map((version) => ({ version, sql: '' }))
    expect(pendingMigrations(steps, [1, 3]).map((m) => m.version)).toEqual([2])
    expect(pendingMigrations(steps, []).map((m) => m.version)).toEqual([1, 2, 3])
  })

  test('schema names must be plain lowercase identifiers', () => {
    expect(checkSchemaName('holtkeeper')).toBe('holtkeeper')
    for (const bad of ['', 'Holt', 'a-b', 'a.b', '1a', 'x"; DROP', 'a'.repeat(64)])
      expect(() => checkSchemaName(bad)).toThrow()
  })

  test('the migration lock is per schema', () => {
    expect(migrationLockKey('a')).not.toBe(migrationLockKey('b'))
  })
})
