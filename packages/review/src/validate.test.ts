import { describe, expect, test } from 'bun:test'

import { parseHunks } from './diff.ts'
import { scopeDiff } from './scope.ts'
import { type Candidate, validateCandidate, validateSuggestion } from './validate.ts'

// New side: 1 a, 2 B, 3 C, 4 d, 5 e — lines 2 and 3 added, 30.. a second hunk.
const diff = '@@ -1,3 +1,5 @@\n a\n+B\n+C\n d\n e\n@@ -40,2 +42,3 @@\n p\n+q\n r\n'
const scope = scopeDiff([{ oldPath: 'f.ts', newPath: 'f.ts', status: 'modified', diff }], {
  ignore: [],
})
const files = new Map(scope.files.map((f) => [f.path, f]))
const file = { visible: scope.files[0]?.visible ?? new Map<number, string>() }

const candidate = (extra: Partial<Candidate>): Candidate => ({
  path: 'f.ts',
  line: 2,
  severity: 'major',
  category: 'bug',
  title: 't',
  body: 'b',
  source: 'agent',
  ...extra,
})

describe('validateSuggestion', () => {
  test('keeps a replacement of exactly the referenced lines', () => {
    expect(validateSuggestion(file, 2, 3, 'B2\nC2\n')).toEqual({
      replacement: 'B2\nC2',
      original: 'B\nC',
    })
  })

  test('trims copies of the neighbouring lines', () => {
    expect(validateSuggestion(file, 2, 3, 'a\nB2\nC2\nd')).toEqual({
      replacement: 'B2\nC2',
      original: 'B\nC',
    })
  })

  test('rejects ranges outside the diff and no-op replacements', () => {
    expect(validateSuggestion(file, 5, 7, 'x')).toBeUndefined()
    expect(validateSuggestion(file, 3, 2, 'x')).toBeUndefined()
    expect(validateSuggestion(file, 2, 2, 'B')).toBeUndefined()
  })
})

describe('validateCandidate', () => {
  test('keeps comments on diff lines with their range and suggestion', () => {
    const result = validateCandidate(
      candidate({ startLine: 2, line: 3, suggestion: { replacement: 'B2\nC2' } }),
      files,
    )
    expect(result).toMatchObject({ line: 3, startLine: 2, suggestion: { original: 'B\nC' } })
  })

  test('moves comments outside the diff to the nearest changed line and drops the suggestion', () => {
    const result = validateCandidate(
      candidate({ line: 8, suggestion: { replacement: 'x' } }),
      files,
    )
    expect(result?.line).toBe(3)
    expect(result?.suggestion).toBeUndefined()
    expect(validateCandidate(candidate({ line: 20 }), files)).toBeUndefined()
  })

  test('drops a suggestion whose range is broken but keeps the comment', () => {
    const result = validateCandidate(
      candidate({ startLine: 1, line: 43, suggestion: { replacement: 'x' } }),
      files,
    )
    expect(result).toMatchObject({ line: 43 })
    expect(result?.startLine).toBeUndefined()
    expect(result?.suggestion).toBeUndefined()
  })

  test('rejects unknown files and normalizes ./ paths', () => {
    expect(validateCandidate(candidate({ path: 'other.ts' }), files)).toBeUndefined()
    expect(validateCandidate(candidate({ path: './f.ts' }), files)?.path).toBe('f.ts')
  })

  test('hunk sanity', () => {
    expect(parseHunks(diff)).toHaveLength(2)
  })
})
