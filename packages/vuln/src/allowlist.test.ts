import { describe, expect, test } from 'bun:test'

import { type AllowlistEntry, allowlistSchema, applyAllowlist } from './allowlist.ts'
import { finding } from './test-helpers.ts'

const now = new Date('2026-10-29T12:00:00Z')
const ids = (findings: { id: string }[]) => findings.map((f) => f.id)

describe('applyAllowlist', () => {
  const findings = [
    finding({ id: 'GHSA-1', aliases: ['CVE-2026-1'] }),
    finding({ id: 'GHSA-2', package: { name: 'qs', version: '6.7.0', ecosystem: 'npm' } }),
    finding({ id: 'GHSA-3', source: 'apps/web/package-lock.json' }),
  ]

  test('matches by id or alias', () => {
    const entries: AllowlistEntry[] = [{ id: 'CVE-2026-1', reason: 'not reachable' }]
    const result = applyAllowlist(findings, entries, { now })
    expect(ids(result.active)).toEqual(['GHSA-2', 'GHSA-3'])
    expect(result.ignored.map((i) => [i.finding.id, i.entry.reason])).toEqual([
      ['GHSA-1', 'not reachable'],
    ])
  })

  test('limits entries by package and path', () => {
    const entries: AllowlistEntry[] = [
      { id: 'GHSA-2', package: 'lodash', reason: 'wrong package' },
      { id: 'GHSA-3', paths: ['apps/**'], reason: 'web only' },
    ]
    expect(ids(applyAllowlist(findings, entries, { now }).active)).toEqual(['GHSA-1', 'GHSA-2'])
  })

  test('expired entries stop hiding findings and are reported', () => {
    const entries: AllowlistEntry[] = [
      { id: 'GHSA-1', reason: 'until today', expires: '2026-10-29' },
      { id: 'GHSA-2', reason: 'stale', expires: '2026-10-28' },
    ]
    const result = applyAllowlist(findings, entries, { now })
    expect(ids(result.active)).toEqual(['GHSA-2', 'GHSA-3'])
    expect(result.expired.map((e) => e.reason)).toEqual(['stale'])
  })

  test('applies conditional entries only to matching traits', () => {
    const entries: AllowlistEntry[] = [{ id: 'GHSA-1', reason: 'SSR only', when: { ssr: false } }]
    expect(
      ids(
        applyAllowlist(findings, entries, { now, traits: { ssr: false } }).ignored.map(
          (i) => i.finding,
        ),
      ),
    ).toEqual(['GHSA-1'])
    expect(applyAllowlist(findings, entries, { now, traits: { ssr: true } }).ignored).toEqual([])
    expect(applyAllowlist(findings, entries, { now }).ignored).toEqual([])
  })
})

describe('allowlistSchema', () => {
  test('requires a reason and a valid date', () => {
    expect(allowlistSchema.safeParse([{ id: 'GHSA-1', reason: '' }]).success).toBe(false)
    expect(
      allowlistSchema.safeParse([{ id: 'GHSA-1', reason: 'x', expires: '29.10.2026' }]).success,
    ).toBe(false)
    expect(
      allowlistSchema.safeParse([{ id: 'GHSA-1', reason: 'x', expires: '2026-10-29' }]).success,
    ).toBe(true)
  })
})
