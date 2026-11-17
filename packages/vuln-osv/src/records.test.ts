import { describe, expect, test } from 'bun:test'

import { cvss3BaseScore } from './cvss.ts'
import { type OsvRecord, findingsForPackage, recordsSeverity } from './records.ts'

describe('cvss3BaseScore', () => {
  test.each([
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1],
    ['CVSS:3.0/AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:N/A:N', 4.7],
    ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H', 9.9],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0],
  ])('%s scores %d', (vector, score) => {
    expect(cvss3BaseScore(vector)).toBe(score)
  })

  test('other versions and incomplete vectors have no score', () => {
    expect(cvss3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBe(
      undefined,
    )
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L')).toBe(undefined)
  })
})

const affected = (name: string, ecosystem: string, introduced: string, fixed?: string) => ({
  package: { name, ecosystem },
  ranges: [{ type: 'SEMVER', events: [{ introduced }, ...(fixed ? [{ fixed }] : [])] }],
})

describe('findingsForPackage', () => {
  const pkg = { ecosystem: 'npm', name: 'some-lib', version: '1.2.0' }

  test('joins records of one issue by id or alias and prefers the GHSA id', () => {
    const records: OsvRecord[] = [
      {
        id: 'OSV-2026-1',
        aliases: ['CVE-2026-1000'],
        summary: 'Prototype pollution in some-lib',
        affected: [affected('some-lib', 'npm', '1.0.0', '1.2.5')],
      },
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        aliases: ['CVE-2026-1000'],
        summary: 'some-lib pollutes prototypes',
        database_specific: { severity: 'HIGH' },
        affected: [affected('some-lib', 'npm', '1.0.0', '1.2.4')],
      },
      {
        id: 'GHSA-dddd-eeee-ffff',
        summary: 'ReDoS in some-lib',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' }],
        affected: [affected('some-lib', 'npm', '0', '2.0.0')],
      },
    ]
    expect(findingsForPackage(pkg, 'pnpm-lock.yaml', records)).toEqual([
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        aliases: ['CVE-2026-1000', 'OSV-2026-1'],
        summary: 'some-lib pollutes prototypes',
        severity: 'high',
        url: 'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc',
        package: pkg,
        source: 'pnpm-lock.yaml',
        fixedVersions: ['1.2.4', '1.2.5'],
      },
      {
        id: 'GHSA-dddd-eeee-ffff',
        aliases: [],
        summary: 'ReDoS in some-lib',
        severity: 'medium',
        url: 'https://osv.dev/vulnerability/GHSA-dddd-eeee-ffff',
        package: pkg,
        source: 'pnpm-lock.yaml',
        fixedVersions: ['2.0.0'],
      },
    ])
  })

  test('leaves withdrawn records out and keeps issues without a fix', () => {
    const findings = findingsForPackage(pkg, 'package-lock.json', [
      { id: 'GHSA-1111-2222-3333', withdrawn: '2026-01-01T00:00:00Z' },
      { id: 'GHSA-4444-5555-6666', affected: [affected('some-lib', 'npm', '0')] },
    ])
    expect(findings.map((finding) => [finding.id, finding.fixedVersions])).toEqual([
      ['GHSA-4444-5555-6666', []],
    ])
  })
})

describe('recordsSeverity', () => {
  test('the highest CVSS 3 score wins over labels, labels over nothing', () => {
    expect(
      recordsSeverity([
        { id: 'A', database_specific: { severity: 'LOW' } },
        {
          id: 'B',
          severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
        },
      ]),
    ).toBe('critical')
    expect(
      recordsSeverity([
        { id: 'A', database_specific: { severity: 'MODERATE' } },
        { id: 'B', database_specific: { severity: 'LOW' } },
      ]),
    ).toBe('medium')
    expect(recordsSeverity([{ id: 'A' }])).toBe('unknown')
  })
})
