import { describe, expect, test } from 'bun:test'

import { SQL } from 'bun'

import { coveredRepos, dimensionFlags, toBucket } from './ai-usage.ts'
import { isUniqueViolation, statusList } from './jobs.ts'
import { RANK_WEIGHTS, knowledgeFilterParams, knowledgeTags, searchTerms } from './knowledge.ts'
import { checkSchemaName, migrationLockKey, migrations, pendingMigrations } from './migrations.ts'

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

  test('rank weights put title over tags over body', () => {
    const [d, c, b, a] = RANK_WEIGHTS
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
    expect(c).toBeGreaterThan(d)
  })

  test('knowledge filters become list and package parameters', () => {
    expect(knowledgeFilterParams()).toEqual({
      statuses: null,
      kinds: null,
      topic: null,
      scope: null,
      packageName: null,
      ecosystem: null,
    })
    expect(
      knowledgeFilterParams({ status: 'accepted', kind: ['quirk', 'howto'], package: 'npm:react' }),
    ).toMatchObject({
      statuses: ['accepted'],
      kinds: ['quirk', 'howto'],
      packageName: 'react',
      ecosystem: 'npm',
    })
    expect(knowledgeFilterParams({ package: 'react' })).toMatchObject({
      packageName: 'react',
      ecosystem: null,
    })
  })

  test('knowledge tags join topics and package names', () => {
    expect(
      knowledgeTags({
        topics: ['testing', 'i18n'],
        packages: [{ ecosystem: 'npm', name: 'vitest' }],
      } as Parameters<typeof knowledgeTags>[0]),
    ).toBe('testing i18n vitest')
  })

  test('dimension flags mark only requested dimensions', () => {
    const flags = dimensionFlags(['week', 'group'])
    expect(
      Object.entries(flags)
        .filter(([, on]) => on)
        .map(([d]) => d),
    ).toEqual(['week', 'group'])
    expect(Object.values(dimensionFlags()).some(Boolean)).toBeFalse()
  })

  test('aggregate rows become buckets keyed by the requested dimensions only', () => {
    const bucket = toBucket(
      {
        k_day: '',
        k_week: '2026-10-05',
        k_month: '',
        k_repo: '',
        k_group: 'games',
        k_model: '',
        k_provider: '',
        k_task_kind: '',
        k_analyzer: '',
        input_tokens: '300',
        output_tokens: '60',
        cache_read_tokens: null,
        cache_write_tokens: '0',
        cost_usd: 0.45,
        runs: 4,
        errors: 1,
        denied: 1,
        avg_duration_ms: null,
      },
      ['week', 'group'],
    )
    expect(bucket).toEqual({
      key: { week: '2026-10-05', group: 'games' },
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.45,
      runs: 4,
      errors: 1,
      denied: 1,
      avgDurationMs: 0,
    })
  })

  test('scope filters keep only covered repositories', () => {
    expect(
      coveredRepos(
        [
          ['work', 'games/slots', ['games']],
          ['work', 'tools/cli', ['tools']],
        ],
        [{ groups: ['tools'] }],
      ),
    ).toEqual([['work', 'tools/cli', ['tools']]])
    expect(coveredRepos([['work', 'games/slots', []]], [])).toEqual([])
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
