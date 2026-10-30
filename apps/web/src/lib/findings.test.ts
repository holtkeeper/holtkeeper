import { describe, expect, test } from 'bun:test'

import type { Finding } from '@holtkeeper/api'

import { facets, firstFix, groupFindings, matchesSearch, toRows } from './findings.ts'

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

describe('groupFindings', () => {
  test('nests language, tool, source and package in row order', () => {
    const rows = toRows([
      finding('a', 'go.mod', 'critical', 'golang.org/x/net', '0.1.0'),
      finding('b', 'web/pnpm-lock.yaml', 'high'),
      finding('c', 'web/pnpm-lock.yaml', 'low'),
      finding('d', 'api/package-lock.json', 'medium', 'axios', '1.0.0'),
      finding('e', 'web/pnpm-lock.yaml', 'medium', 'axios', '1.0.0'),
    ])
    const groups = groupFindings(rows)
    expect(groups.map((g) => g.language)).toEqual(['Go', 'JavaScript'])
    const js = groups[1]
    expect(js?.count).toBe(4)
    expect(js?.worst).toBe('high')
    expect(js?.tools.map((t) => t.label)).toEqual(['pnpm', 'npm'])
    const pnpm = js?.tools[0]?.sources[0]
    expect(pnpm?.source).toBe('web/pnpm-lock.yaml')
    expect(pnpm?.packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      'lodash@4.17.20',
      'axios@1.0.0',
    ])
    expect(pnpm?.packages[0]?.rows).toHaveLength(2)
    expect(pnpm?.packages[0]?.worst).toBe('high')
  })

  test('returns nothing for no rows', () => {
    expect(groupFindings([])).toEqual([])
  })
})

describe('search and facets', () => {
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

  test('collects sorted facets', () => {
    expect(facets(rows)).toEqual({ languages: ['Go', 'JavaScript'], tools: ['Bun', 'Go modules'] })
  })

  test('first fix', () => {
    expect(firstFix(rows[0]!.finding)).toBe('4.17.21')
    expect(firstFix({ ...rows[0]!.finding, fixedVersions: [] })).toBeUndefined()
  })
})
