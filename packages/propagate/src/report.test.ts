import { describe, expect, test } from 'bun:test'

import { propagationAnalysis, waveTotals } from './report.ts'
import type { PropagationData, RepoOutcome } from './types.ts'

const outcome = (
  repo: string,
  status: RepoOutcome['status'],
  extra: Partial<RepoOutcome> = {},
): RepoOutcome => ({
  repo,
  webUrl: `https://git.test/${repo}`,
  status,
  usages: [],
  bumps: [],
  checks: [],
  attempts: 0,
  changedFiles: [],
  fixedFiles: [],
  notes: [],
  ...extra,
})

const wave = (repos: RepoOutcome[], name = '@acme/ui'): PropagationData => ({
  group: 'games',
  packages: [{ name, ecosystem: 'npm', requested: '2.0.0', version: '2.0.0' }],
  dryRun: false,
  repos,
  releaseNotes: [
    {
      package: name,
      from: '1.0.0',
      to: '2.0.0',
      source: 'node_modules/@acme/ui',
      text: '## 2.0.0',
    },
  ],
})

const record = (data: PropagationData, createdAt: string) => ({
  id: createdAt,
  repo: { forge: 'work', path: 'games' },
  kind: 'propagation',
  createdAt,
  data,
})

const failing = {
  name: 'test',
  command: 'bun test',
  exitCode: 1,
  ok: false,
  output: 'line\n'.repeat(50) + 'expected 2',
  durationMs: 10,
  attempt: 3,
}

describe('propagation report', () => {
  const previous = wave([outcome('games/a', 'failed'), outcome('games/b', 'updated')])
  const current = wave([
    outcome('games/a', 'fixed', {
      attempts: 1,
      agent: { summary: 'Migrated.', changes: ['src/a.ts'], remainingProblems: [] },
      fixedFiles: ['src/a.ts'],
      bumps: [{ package: '@acme/ui', from: '^1.0.0', to: '^2.0.0', manifest: 'package.json' }],
      usages: [
        {
          package: '@acme/ui',
          ecosystem: 'npm',
          manifest: 'package.json',
          path: ['dependencies', '@acme/ui'],
          kind: 'prod',
          declared: '^1.0.0',
          current: '1.0.0',
          next: '^2.0.0',
        },
      ],
      mergeRequest: { id: 3, url: 'https://git.test/games/a/-/merge_requests/3', draft: false },
    }),
    outcome('games/b', 'updated'),
    outcome('games/c', 'failed', {
      checks: [failing],
      attempts: 3,
      mergeRequest: { id: 4, url: 'https://git.test/games/c/-/merge_requests/4', draft: true },
    }),
    outcome('games/d', 'error', { error: 'clone failed' }),
    outcome('games/e', 'skipped'),
  ])

  test('totals', () => {
    expect(waveTotals(current)).toEqual({
      targeted: 5,
      updated: 1,
      fixed: 1,
      failed: 2,
      skipped: 1,
      mergeRequests: 2,
    })
  })

  test('metrics carry deltas against the previous wave of the same packages', () => {
    const report = propagationAnalysis.toReport(record(current, '2'), record(previous, '1'))
    const byId = Object.fromEntries(report.metrics.map((metric) => [metric.id, metric]))
    expect(byId['fixed']).toMatchObject({ value: 1, delta: 1, tone: 'info' })
    expect(byId['failed']).toMatchObject({ value: 2, delta: 1, tone: 'bad', better: 'down' })
    const other = propagationAnalysis.toReport(record(current, '2'), record(wave([], 'react'), '1'))
    expect(other.metrics.every((metric) => metric.delta === undefined)).toBe(true)
  })

  test('sections', () => {
    const report = propagationAnalysis.toReport(record(current, '2'), record(previous, '1'))
    expect(report.title).toBe('Rollout of @acme/ui@2.0.0')
    expect(report.sections.map((section) => section.id)).toEqual([
      'overview',
      'fixed',
      'failures',
      'release-notes',
      'plan',
    ])
    const [chart, table] = report.sections[0]!.blocks
    expect(chart).toMatchObject({ type: 'chart', chart: 'stacked-bar' })
    if (chart?.type !== 'chart' || table?.type !== 'table') throw new Error('unexpected blocks')
    expect(chart.data).toEqual([
      {
        wave: '@acme/ui@2.0.0',
        updated: 1,
        fixed: 1,
        failed: 1,
        error: 1,
        unchanged: 0,
        skipped: 1,
      },
    ])
    expect(table.columns.map((column) => column.key)).toContain('previous')
    const first = table.rows[0]!
    expect(first['status']).toEqual({ text: 'updated', tone: 'good' })
    const a = table.rows.find((row) => JSON.stringify(row['repo']).includes('games/a'))!
    expect(a['previous']).toEqual({ text: 'failed', tone: 'bad' })
    expect(a['mergeRequest']).toMatchObject({
      text: '!3',
      href: 'https://git.test/games/a/-/merge_requests/3',
    })
    const fixed = report.sections[1]!.blocks[0]
    expect(fixed?.type === 'markdown' && fixed.text).toContain('Files: `src/a.ts`')
    const issues = report.sections[2]!.blocks[0]
    if (issues?.type !== 'issues') throw new Error('expected issues')
    expect(issues.items.map((item) => item.title)).toEqual([
      'games/c: test fails (exit 1)',
      'games/d: clone failed',
    ])
    expect(issues.items[0]!.detail).toContain('expected 2')
    expect(issues.items[0]!.href).toBe('https://git.test/games/c/-/merge_requests/4')
  })

  test('schema accepts the data', () => {
    expect(propagationAnalysis.schema.parse(current)).toEqual(current)
  })
})
