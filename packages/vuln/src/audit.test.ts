import { describe, expect, test } from 'bun:test'

import { runAudit } from './audit.ts'
import { finding } from './test-helpers.ts'
import type { Finding, Fixer, FixRequest, Scanner } from './types.ts'

function sequenceScanner(...scans: Finding[][]): Scanner & { calls: number } {
  return {
    name: 'fake',
    calls: 0,
    async scan() {
      const result = scans[Math.min(this.calls, scans.length - 1)] ?? []
      this.calls++
      return result
    },
  }
}

function fakeFixer(
  name: string,
  fixes: string[],
  options: { supports?: string; fail?: boolean } = {},
) {
  const requests: FixRequest[] = []
  const fixer: Fixer = {
    name,
    supports: (source) => !options.supports || source.endsWith(options.supports),
    async fix(request) {
      requests.push(request)
      if (options.fail) throw new Error(`${name} broke`)
      const fixed = request.findings.map((f) => f.id).filter((id) => fixes.includes(id))
      return { changedFiles: fixed.length ? [request.source] : [], fixed, notes: [] }
    },
  }
  return { fixer, requests }
}

const a = finding({ id: 'GHSA-a' })
const b = finding({ id: 'GHSA-b' })
const go = finding({
  id: 'GO-1',
  source: 'go.mod',
  package: { name: 'golang.org/x/text', version: '0.3.0', ecosystem: 'Go' },
})

describe('runAudit', () => {
  test('reports without fixing when no fixers are given', async () => {
    const scanner = sequenceScanner([a, b])
    const report = await runAudit({ dir: '/repo', scanner })
    expect(report.findings).toEqual([a, b])
    expect(report.fixes).toEqual([])
    expect(scanner.calls).toBe(1)
  })

  test('hides allowlisted findings before fixing', async () => {
    const { fixer, requests } = fakeFixer('first', [])
    await runAudit({
      dir: '/repo',
      scanner: sequenceScanner([a, b]),
      fixers: [fixer],
      allowlist: [{ id: 'GHSA-a', reason: 'accepted' }],
    })
    expect(requests.map((r) => r.findings.map((f) => f.id))).toEqual([['GHSA-b']])
  })

  test('passes leftovers to the next supporting fixer and rescans', async () => {
    const first = fakeFixer('osv', ['GHSA-a'])
    const skipped = fakeFixer('go', [], { supports: 'go.mod' })
    const second = fakeFixer('js', ['GHSA-b'])
    const scanner = sequenceScanner([a, b], [])

    const report = await runAudit({
      dir: '/repo',
      scanner,
      fixers: [first.fixer, skipped.fixer, second.fixer],
    })

    expect(second.requests.map((r) => r.findings.map((f) => f.id))).toEqual([['GHSA-b']])
    expect(skipped.requests).toEqual([])
    expect(report.findings).toEqual([])
    expect(report.resolved).toEqual([a, b])
    expect(report.changedFiles).toEqual(['package-lock.json'])
    expect(scanner.calls).toBe(2)
  })

  test('groups findings by source', async () => {
    const js = fakeFixer('js', ['GHSA-a'], { supports: 'package-lock.json' })
    const goFixer = fakeFixer('go', ['GO-1'], { supports: 'go.mod' })
    await runAudit({
      dir: '/repo',
      scanner: sequenceScanner([a, go], []),
      fixers: [js.fixer, goFixer.fixer],
    })
    expect(js.requests.map((r) => r.source)).toEqual(['package-lock.json'])
    expect(goFixer.requests.map((r) => r.findings)).toEqual([[go]])
  })

  test('records fixer errors and keeps going', async () => {
    const broken = fakeFixer('broken', [], { fail: true })
    const working = fakeFixer('working', ['GHSA-a'])
    const report = await runAudit({
      dir: '/repo',
      scanner: sequenceScanner([a], []),
      fixers: [broken.fixer, working.fixer],
    })
    expect(report.fixes.map((f) => [f.fixer, f.error])).toEqual([
      ['broken', 'broken broke'],
      ['working', undefined],
    ])
    expect(report.resolved).toEqual([a])
  })

  test('trusts the rescan over fixer claims', async () => {
    const liar = fakeFixer('liar', ['GHSA-a'])
    const report = await runAudit({
      dir: '/repo',
      scanner: sequenceScanner([a], [a]),
      fixers: [liar.fixer],
    })
    expect(report.findings).toEqual([a])
    expect(report.resolved).toEqual([])
  })

  test('skips the rescan when nothing changed', async () => {
    const noop = fakeFixer('noop', [])
    const scanner = sequenceScanner([a])
    await runAudit({ dir: '/repo', scanner, fixers: [noop.fixer] })
    expect(scanner.calls).toBe(1)
  })
})
