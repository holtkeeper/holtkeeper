import { describe, expect, test } from 'bun:test'

import type { OsvRecord } from '@holtkeeper/vuln-osv'

import { type InventoryPackage } from './inventory.ts'
import { packageKey } from './match.ts'
import { INDEX_SCANNER, fixableKeys, indexAuditReport, sameAuditState } from './report.ts'

const affected = (name: string, fixed?: string) => [
  {
    package: { name, ecosystem: 'npm' },
    ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, ...(fixed ? [{ fixed }] : [])] }],
  },
]

const someLib: InventoryPackage = {
  ecosystem: 'npm',
  name: 'some-lib',
  version: '1.0.0',
  source: 'bun.lock',
}
const otherLib: InventoryPackage = {
  ecosystem: 'npm',
  name: 'other-lib',
  version: '2.0.0',
  source: 'bun.lock',
}

const records = new Map<string, OsvRecord[]>([
  [
    packageKey(someLib),
    [{ id: 'GHSA-aaaa-bbbb-cccc', summary: 'fixable', affected: affected('some-lib', '1.0.1') }],
  ],
  [
    packageKey(otherLib),
    [{ id: 'GHSA-dddd-eeee-ffff', summary: 'no fix', affected: affected('other-lib') }],
  ],
])

describe('indexAuditReport', () => {
  test('builds findings, applies the allowlist and attempts no fixes', () => {
    const report = indexAuditReport({
      packages: [someLib, otherLib, { ...someLib, name: 'clean-lib' }],
      records,
      allowlist: [
        { id: 'GHSA-dddd-eeee-ffff', reason: 'build-time only' },
        { id: 'GHSA-0000-0000-0000', reason: 'old', expires: '2026-01-01' },
      ],
      now: new Date('2026-11-18T00:00:00Z'),
    })
    expect(report.scanner).toBe(INDEX_SCANNER)
    expect(report.findings.map((finding) => finding.id)).toEqual(['GHSA-aaaa-bbbb-cccc'])
    expect(report.ignored.map(({ finding }) => finding.id)).toEqual(['GHSA-dddd-eeee-ffff'])
    expect(report.expired.map((entry) => entry.id)).toEqual(['GHSA-0000-0000-0000'])
    expect(report).toMatchObject({ fixes: [], resolved: [], changedFiles: [] })
    expect(fixableKeys(report)).toEqual(['GHSA-aaaa-bbbb-cccc|npm|some-lib|1.0.0'])
  })
})

describe('sameAuditState', () => {
  test('ignores order, scanner and fix attempts but not findings', () => {
    const report = indexAuditReport({ packages: [someLib, otherLib], records })
    const reordered = {
      ...report,
      scanner: 'osv-scanner',
      findings: report.findings.toReversed(),
      fixes: [
        {
          fixer: 'js',
          source: 'bun.lock',
          requested: [],
          changedFiles: [],
          fixed: [],
          notes: [],
        },
      ],
    }
    expect(sameAuditState(report, reordered)).toBe(true)
    expect(sameAuditState(report, { ...report, findings: report.findings.slice(1) })).toBe(false)
  })
})
