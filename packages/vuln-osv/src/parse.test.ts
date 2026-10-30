import { describe, expect, test } from 'bun:test'

import scan from '../test/fixtures/scan.json'
import { fixedVersionsFor, parseScanOutput } from './parse.ts'

describe('parseScanOutput', () => {
  const findings = parseScanOutput(scan, '/project')

  test('creates one finding per advisory group with relative sources', () => {
    expect(findings).toHaveLength(9)
    expect(new Set(findings.map((f) => f.source))).toEqual(new Set(['package-lock.json']))
  })

  test('maps ids, aliases, severity and fixed versions', () => {
    expect(findings.find((f) => f.id === 'GHSA-27r3-jxmh-p828')).toEqual({
      id: 'GHSA-27r3-jxmh-p828',
      aliases: ['CVE-2026-111181'],
      summary: expect.any(String),
      severity: 'high',
      url: 'https://osv.dev/vulnerability/GHSA-27r3-jxmh-p828',
      package: { name: 'body-parser', version: '1.19.0', ecosystem: 'npm' },
      source: 'package-lock.json',
      fixedVersions: ['1.20.9'],
    })
    expect(findings.find((f) => f.id === 'GHSA-v422-hmwv-36x6')?.severity).toBe('low')
  })

  test('handles empty output', () => {
    expect(parseScanOutput({}, '/project')).toEqual([])
  })

  test('falls back to advisory severity and ungrouped vulnerabilities', () => {
    const [finding] = parseScanOutput(
      {
        results: [
          {
            source: { path: '/project/go.mod', type: 'lockfile' },
            packages: [
              {
                package: { name: 'golang.org/x/text', version: '0.3.0', ecosystem: 'Go' },
                vulnerabilities: [
                  {
                    id: 'GO-2021-0113',
                    aliases: ['CVE-2021-38561'],
                    database_specific: { severity: 'MODERATE' },
                  },
                ],
              },
            ],
          },
        ],
      },
      '/project',
    )
    expect(finding).toMatchObject({
      id: 'GO-2021-0113',
      aliases: ['CVE-2021-38561'],
      severity: 'medium',
      source: 'go.mod',
    })
  })
})

describe('fixedVersionsFor', () => {
  const pkg = { name: 'body-parser', version: '1.19.0', ecosystem: 'npm' }
  const affected = (events: { introduced?: string; fixed?: string }[], type = 'SEMVER') => ({
    id: 'X',
    affected: [
      { package: { name: pkg.name, ecosystem: pkg.ecosystem }, ranges: [{ type, events }] },
    ],
  })

  test('keeps only fixes for ranges containing the version, lowest first', () => {
    const vulnerabilities = [
      affected([{ introduced: '2.0.0' }, { fixed: '2.4.0' }]),
      affected([{ introduced: '0' }, { fixed: '1.20.9' }]),
      affected([{ introduced: '1.0.0' }, { fixed: '1.20.3' }]),
    ]
    expect(fixedVersionsFor(vulnerabilities, pkg)).toEqual(['1.20.3', '1.20.9'])
  })

  test('ignores git ranges and other packages', () => {
    expect(
      fixedVersionsFor([affected([{ introduced: '0' }, { fixed: 'abc123' }], 'GIT')], pkg),
    ).toEqual([])
    expect(
      fixedVersionsFor([affected([{ introduced: '0' }, { fixed: '2.0.0' }])], {
        ...pkg,
        name: 'qs',
      }),
    ).toEqual([])
  })

  test('returns every fix when versions are not semver', () => {
    const maven = { name: 'org.example:lib', version: '1.2.3.Final', ecosystem: 'Maven' }
    const vulnerability = {
      id: 'X',
      affected: [
        {
          package: { name: maven.name, ecosystem: 'Maven' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '1.2.4.Final' }] }],
        },
      ],
    }
    expect(fixedVersionsFor([vulnerability], maven)).toEqual(['1.2.4.Final'])
  })
})
