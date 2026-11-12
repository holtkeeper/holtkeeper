import { describe, expect, test } from 'bun:test'

import type { Finding } from '@holtkeeper/api'

import { filterFindingRows, firstFix, matchesSearch, sortFindingRows, toRows } from './findings.ts'

const finding = (
  id: string,
  source: string,
  severity: Finding['severity'],
  name = 'lodash',
  version = '4.17.20',
): Finding => ({
  id,
  aliases: [`CVE-${id}`],
  summary: `Problem ${id}`,
  severity,
  url: `https://osv.dev/${id}`,
  package: { name, version, ecosystem: 'npm' },
  source,
  fixedVersions: ['4.17.21', '5.0.0'],
})

describe('toRows', () => {
  test('resolves source info and keeps keys unique', () => {
    const rows = toRows([finding('1', 'bun.lock', 'high'), finding('1', 'bun.lock', 'high')])
    expect(rows[0]?.info.label).toBe('Bun')
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })
})

describe('sortFindingRows and filterFindingRows', () => {
  const rows = toRows([
    finding('b', 'bun.lock', 'low', 'zod', '3.0.0'),
    finding('a', 'bun.lock', 'critical', 'widget-kit', '1.0.0'),
    finding('c', 'bun.lock', 'low', 'fooUtil', '2.0.0'),
  ])

  test('orders worst severity first, then package', () => {
    expect(sortFindingRows(rows).map((r) => r.finding.id)).toEqual(['a', 'c', 'b'])
  })

  test('filters by severity and text', () => {
    expect(filterFindingRows(rows, '', ['low']).map((r) => r.finding.id)).toEqual(['b', 'c'])
    expect(filterFindingRows(rows, 'widget').map((r) => r.finding.id)).toEqual(['a'])
    expect(filterFindingRows(rows, 'widget', ['low'])).toEqual([])
  })
})

describe('search', () => {
  const rows = toRows([
    finding('GHSA-1', 'bun.lock', 'high'),
    finding('X', 'go.mod', 'low', 'net', '1'),
  ])

  test('matches ids, aliases, packages and summaries case-insensitively', () => {
    expect(matchesSearch(rows[0]!, 'ghsa')).toBe(true)
    expect(matchesSearch(rows[0]!, 'cve-ghsa-1')).toBe(true)
    expect(matchesSearch(rows[0]!, 'LODASH')).toBe(true)
    expect(matchesSearch(rows[1]!, 'lodash')).toBe(false)
    expect(matchesSearch(rows[1]!, '  ')).toBe(true)
  })

  test('first fix', () => {
    expect(firstFix(rows[0]!.finding)).toBe('4.17.21')
    expect(firstFix({ ...rows[0]!.finding, fixedVersions: [] })).toBeUndefined()
  })
})
