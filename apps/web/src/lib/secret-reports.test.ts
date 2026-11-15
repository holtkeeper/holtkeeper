import { describe, expect, test } from 'bun:test'

import type { SecretReportView } from '@holtkeeper/api'

import {
  filterReports,
  isOpenReport,
  parseSecretReportsSearch,
  repeatsLabel,
  reportStatusActions,
  reportStatusCounts,
  reportedLabel,
  secretsMatchCommand,
} from './secret-reports.ts'

const report = (patch: Partial<SecretReportView>): SecretReportView => ({
  id: 'r1',
  kind: 'api-key',
  identifier: 'WIDGET_API_KEY',
  masked: 'wk_l…(40)',
  channel: 'chat',
  status: 'new',
  reportedAt: '2026-11-10T09:30:00Z',
  repeats: 0,
  ...patch,
})

const reports = [
  report({ id: 'a', service: 'widgets.example.com', reportedAt: '2026-11-09T08:00:00Z' }),
  report({
    id: 'b',
    kind: 'password',
    identifier: 'GADGET_DB_PASSWORD',
    repo: 'gitlab:acme/gadget',
    status: 'acknowledged',
    reportedAt: '2026-11-11T00:00:00Z',
  }),
  report({ id: 'c', kind: 'token', identifier: 'SPROCKET_TOKEN', status: 'rotated' }),
  report({ id: 'd', status: 'false-positive', identifier: 'FOO_SECRET' }),
]

const ids = (filter: Parameters<typeof filterReports>[1]) =>
  filterReports(reports, filter).map((each) => each.id)

describe('secret report filters', () => {
  test('open means new or acknowledged', () => {
    expect(isOpenReport('new')).toBe(true)
    expect(isOpenReport('acknowledged')).toBe(true)
    expect(isOpenReport('rotated')).toBe(false)
    expect(isOpenReport('false-positive')).toBe(false)
  })

  test('counts every status filter', () => {
    expect(reportStatusCounts(reports)).toEqual({
      open: 2,
      all: 4,
      new: 1,
      acknowledged: 1,
      rotated: 1,
      'false-positive': 1,
    })
  })

  test('keeps open reports newest first by default', () => {
    expect(
      filterReports(reports, { status: 'open', kinds: [], query: '' }).map((each) => each.id),
    ).toEqual(['b', 'a'])
  })

  test('narrows by status, kind and text over identifier, service and repo', () => {
    expect(ids({ status: 'all', kinds: ['token'], query: '' })).toEqual(['c'])
    expect(ids({ status: 'rotated', kinds: [], query: '' })).toEqual(['c'])
    expect(ids({ status: 'all', kinds: [], query: 'WIDGETS.example' })).toEqual(['a'])
    expect(ids({ status: 'all', kinds: [], query: 'acme/gadget' })).toEqual(['b'])
    expect(ids({ status: 'all', kinds: [], query: 'foo_' })).toEqual(['d'])
  })
})

describe('secret report labels', () => {
  test('anonymous reports show their time as approximate', () => {
    const label = reportedLabel(report({ reportedAt: '2026-11-10T12:34:00Z' }))
    expect(label.startsWith('≈ ')).toBe(true)
    expect(label).toContain('2026')
  })

  test('named reports show date and time', () => {
    const label = reportedLabel(report({ reporter: { id: 'u1', name: 'Alex Example' } }))
    expect(label).toContain('2026')
    expect(label).toMatch(/\d:\d\d/)
  })

  test('repeats read as a multiplier only when there are some', () => {
    expect(repeatsLabel(0)).toBe('')
    expect(repeatsLabel(3)).toBe('×3')
  })

  test('status actions follow the current status', () => {
    expect(reportStatusActions('new').map((each) => each.label)).toEqual([
      'Acknowledge',
      'Mark rotated',
      'False positive',
    ])
    expect(reportStatusActions('acknowledged').map((each) => each.status)).toEqual([
      'rotated',
      'false-positive',
    ])
    expect(reportStatusActions('rotated')).toEqual([{ status: 'new', label: 'Reopen' }])
  })

  test('the match command carries the fingerprint', () => {
    expect(secretsMatchCommand('0123456789abcdef')).toBe(
      'holtkeeper secrets match 0123456789abcdef --address https://bao.example.com --mount secret',
    )
  })
})

test('parses the open report from the URL', () => {
  expect(parseSecretReportsSearch({ report: 'r1', other: 'x' })).toEqual({ report: 'r1' })
  expect(parseSecretReportsSearch({ report: '' })).toEqual({})
})
