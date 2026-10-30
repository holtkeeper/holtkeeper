import { describe, expect, test } from 'bun:test'

import {
  type AuditReport,
  type AuditRunSummary,
  type Finding,
  emptySeverities,
} from '@holtkeeper/api'

import {
  activeTrend,
  breakdown,
  breakdownFromSummaries,
  latestTotals,
  needsAttention,
  sparkline,
  topPackages,
} from './dashboard.ts'

const summary = (
  path: string,
  finishedAt: string,
  high: number,
  extra: Partial<AuditRunSummary> = {},
): AuditRunSummary => ({
  id: `${path}-${finishedAt}`,
  repo: { forge: 'work', path },
  trigger: 'schedule',
  startedAt: finishedAt,
  finishedAt,
  severities: { ...emptySeverities(), high },
  active: high,
  ignored: 0,
  resolved: 0,
  expiredAllowlist: 0,
  languages: ['JavaScript'],
  tools: ['npm'],
  changedFiles: 0,
  ...extra,
})

const finding = (name: string, source: string, severity: Finding['severity']): Finding => ({
  id: name + source,
  aliases: [],
  summary: '',
  severity,
  url: '',
  package: { name, version: '1', ecosystem: 'npm' },
  source,
  fixedVersions: [],
})

const report = (findings: Finding[]): AuditReport => ({
  scanner: 'osv',
  findings,
  ignored: [],
  expired: [],
  fixes: [],
  resolved: [],
  changedFiles: [],
})

describe('activeTrend', () => {
  test('carries the latest run per repository forward day by day', () => {
    const runs = [
      summary('a', '2026-10-26T10:00:00.000Z', 3),
      summary('a', '2026-10-28T10:00:00.000Z', 1),
      summary('b', '2026-10-27T10:00:00.000Z', 2),
    ]
    const trend = activeTrend(runs, 4, new Date('2026-10-29T08:00:00.000Z'))
    expect(trend.map((p) => [p.day, p.total])).toEqual([
      ['2026-10-26', 3],
      ['2026-10-27', 5],
      ['2026-10-28', 3],
      ['2026-10-29', 3],
    ])
    expect(trend[1]?.high).toBe(5)
  })
})

describe('totals and attention', () => {
  const repos = [
    { repo: { forge: 'w', path: 'a' }, groups: [], latestAudit: summary('a', 'x', 2) },
    { repo: { forge: 'w', path: 'b' }, groups: [] },
    {
      repo: { forge: 'w', path: 'c' },
      groups: [],
      latestAudit: summary('c', 'x', 0, {
        severities: { ...emptySeverities(), critical: 1 },
        active: 1,
      }),
    },
    { repo: { forge: 'w', path: 'd' }, groups: [], latestAudit: summary('d', 'x', 0) },
  ]

  test('sums latest audits', () => {
    const totals = latestTotals(repos)
    expect(totals.active).toBe(3)
    expect(totals.critical).toBe(1)
    expect(totals.high).toBe(2)
  })

  test('lists repositories with findings, worst first', () => {
    expect(needsAttention(repos).map((r) => r.repo.path)).toEqual(['c', 'a'])
  })
})

describe('breakdowns', () => {
  test('counts findings by language and tool', () => {
    const result = breakdown([
      report([
        finding('x', 'go.mod', 'low'),
        finding('y', 'bun.lock', 'low'),
        finding('z', 'a/bun.lock', 'high'),
      ]),
    ])
    expect(result.languages).toEqual([
      { name: 'JavaScript', count: 2 },
      { name: 'Go', count: 1 },
    ])
    expect(result.tools[0]).toEqual({ name: 'Bun', count: 2 })
  })

  test('falls back to repositories per language', () => {
    const result = breakdownFromSummaries([
      summary('a', 'x', 1),
      summary('b', 'x', 1, { languages: ['Go'], tools: ['Go modules'] }),
    ])
    expect(result.languages).toEqual([
      { name: 'Go', count: 1 },
      { name: 'JavaScript', count: 1 },
    ])
  })

  test('ranks affected packages', () => {
    const top = topPackages([
      {
        repo: 'a',
        report: report([
          finding('lodash', 'bun.lock', 'low'),
          finding('axios', 'bun.lock', 'critical'),
        ]),
      },
      { repo: 'b', report: report([finding('lodash', 'package-lock.json', 'high')]) },
    ])
    expect(top).toEqual([
      { name: 'lodash', ecosystem: 'npm', findings: 2, repos: 2, worst: 'high' },
      { name: 'axios', ecosystem: 'npm', findings: 1, repos: 1, worst: 'critical' },
    ])
  })
})

test('sparkline is chronological', () => {
  expect(
    sparkline([summary('a', '2026-10-02', 1), summary('a', '2026-10-01', 4)]).map((p) => p.active),
  ).toEqual([4, 1])
})
