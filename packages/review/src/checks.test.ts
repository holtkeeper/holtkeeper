import { describe, expect, test } from 'bun:test'

import type { CodeChange } from '@holtkeeper/changes'
import type { QualityIssue } from '@holtkeeper/quality'

import { findingsFromQuality, suggestionFromChange } from './checks.ts'
import { scopeDiff } from './scope.ts'

// New side: 1 import x, 2 let a = 1, 3 let b = 2, 4 keep — lines 2-3 added.
const diff = '@@ -1,2 +1,4 @@\n import x\n+let a = 1\n+let b = 2\n keep\n'
const scope = scopeDiff([{ oldPath: 'f.ts', newPath: 'f.ts', status: 'modified', diff }], {
  ignore: [],
})
const files = new Map(scope.files.map((f) => [f.path, f]))
const file = scope.files[0]!

const change = (edits: CodeChange['edits']): CodeChange => ({
  id: 'c1',
  title: 'fix',
  confidence: 'safe',
  source: 'oxlint',
  edits,
})

describe('suggestionFromChange', () => {
  test('applies column edits to whole changed lines', () => {
    const result = suggestionFromChange(
      change([
        {
          kind: 'replace',
          file: 'f.ts',
          range: { start: { line: 2, column: 1 }, end: { line: 2, column: 4 } },
          oldText: 'let',
          newText: 'const',
        },
        {
          kind: 'replace',
          file: 'f.ts',
          range: { start: { line: 3, column: 1 }, end: { line: 3, column: 4 } },
          oldText: 'let',
          newText: 'const',
        },
      ]),
      file,
    )
    expect(result).toEqual({
      startLine: 2,
      line: 3,
      replacement: 'const a = 1\nconst b = 2',
      original: 'let a = 1\nlet b = 2',
    })
  })

  test('rejects edits reaching unchanged lines or with stale oldText', () => {
    const outside = change([
      {
        kind: 'replace',
        file: 'f.ts',
        range: { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } },
        oldText: 'import x\n',
        newText: '',
      },
    ])
    expect(suggestionFromChange(outside, file)).toBeUndefined()
    const stale = change([
      {
        kind: 'replace',
        file: 'f.ts',
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 4 } },
        oldText: 'var',
        newText: 'const',
      },
    ])
    expect(suggestionFromChange(stale, file)).toBeUndefined()
  })
})

const issue = (line: number, extra: Partial<QualityIssue> = {}): QualityIssue => ({
  id: `i${line}`,
  tool: 'oxlint',
  rule: 'prefer-const',
  category: 'lint',
  severity: 'warning',
  message: 'Use const',
  file: 'f.ts',
  range: { start: { line, column: 1 }, end: { line, column: 4 } },
  ...extra,
})

test('findingsFromQuality keeps issues on changed lines and maps severity', () => {
  const findings = findingsFromQuality(
    {
      issues: [
        issue(2, { changeId: 'c1' }),
        issue(1),
        issue(3, { tool: 'gitleaks', rule: 'aws-key', category: 'security', severity: 'error' }),
        issue(2, { file: 'other.ts' }),
      ],
      changes: [
        change([
          {
            kind: 'replace',
            file: 'f.ts',
            range: { start: { line: 2, column: 1 }, end: { line: 2, column: 4 } },
            oldText: 'let',
            newText: 'const',
          },
        ]),
      ],
    },
    files,
  )
  expect(findings.map((f) => [f.line, f.severity, f.category, f.source])).toEqual([
    [2, 'minor', 'maintainability', 'oxlint'],
    [3, 'critical', 'security', 'gitleaks'],
  ])
  expect(findings[0]?.suggestion).toEqual({ replacement: 'const a = 1', original: 'let a = 1' })
})
