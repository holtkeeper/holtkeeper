import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { parseGitleaksReport } from './parse.ts'

const fixture = (name: string) => Bun.file(join(import.meta.dir, '../test', name)).json()

const findingAt = (root: string) => [
  { RuleID: 'r', StartLine: 2, File: `${root}/a.txt`, Fingerprint: `${root}/a.txt:r:2` },
]

describe('parseGitleaksReport', () => {
  test('maps a working tree report to security errors with fixed columns', async () => {
    const issues = parseGitleaksReport(await fixture('gitleaks-dir.json'), { dir: '/repo' })
    expect(
      issues
        .map((issue) => ({ rule: issue.rule, file: issue.file, range: issue.range }))
        .toSorted((a, b) =>
          `${a.file}${a.range?.start.line}`.localeCompare(`${b.file}${b.range?.start.line}`),
        ),
    ).toEqual([
      {
        rule: 'github-pat',
        file: '.env',
        range: { start: { line: 1, column: 14 }, end: { line: 1, column: 54 } },
      },
      {
        rule: 'github-pat',
        file: 'notes.txt',
        range: { start: { line: 3, column: 4 }, end: { line: 3, column: 44 } },
      },
      {
        rule: 'aws-access-token',
        file: 'src/config.js',
        range: { start: { line: 2, column: 17 }, end: { line: 2, column: 37 } },
      },
    ])
    for (const issue of issues) {
      expect(issue).toMatchObject({ tool: 'gitleaks', category: 'security', severity: 'error' })
      expect(issue.message.length).toBeGreaterThan(10)
      expect(issue.help).not.toContain('commit')
    }
  })

  test('puts commit, author and date of history findings in help', async () => {
    const issues = parseGitleaksReport(await fixture('gitleaks-git.json'), { dir: '/repo' })
    const aws = issues.find((issue) => issue.rule === 'aws-access-token')
    expect(aws?.file).toBe('src/config.js')
    expect(aws?.message).toContain('(commit 4e5125d67d71)')
    expect(aws?.help).toContain(
      'commit 4e5125d67d71a81183e8325d06aa98467cd4aa5c by Tester on 2026-10-29T23:00:48Z',
    )
  })

  test('never copies the matched text or secret', () => {
    const [issue] = parseGitleaksReport(
      [
        {
          RuleID: 'generic-api-key',
          Description: 'Generic API key',
          StartLine: 1,
          EndLine: 1,
          StartColumn: 1,
          EndColumn: 10,
          Match: 'key=hunter22',
          Secret: 'hunter22',
          Line: 'key=hunter22',
          File: '/repo/a.env',
          Fingerprint: '/repo/a.env:generic-api-key:1',
        },
      ],
      { dir: '/repo' },
    )
    expect(JSON.stringify(issue)).not.toContain('hunter22')
    expect(issue?.file).toBe('a.env')
  })

  test('ids do not depend on where the checkout lives', () => {
    const [a] = parseGitleaksReport(findingAt('/one'), { dir: '/one' })
    const [b] = parseGitleaksReport(findingAt('/two/deeper'), { dir: '/two/deeper' })
    expect(a?.id).toBe(b?.id ?? '')
    expect(a?.range).toEqual({ start: { line: 2, column: 1 }, end: { line: 3, column: 1 } })
  })

  test('accepts an empty or null report', () => {
    expect(parseGitleaksReport([], { dir: '/repo' })).toEqual([])
    expect(parseGitleaksReport(null, { dir: '/repo' })).toEqual([])
  })
})
