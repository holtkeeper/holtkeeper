import { describe, expect, test } from 'bun:test'

import {
  invalidReason,
  lineCode,
  locateLine,
  parseHunks,
  renderBody,
  textPosition,
} from './review.ts'

const DIFF = [
  '@@ -1,4 +1,5 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' const d = 5',
  ' const e = 6',
  '@@ -10,3 +11,3 @@',
  ' line10',
  '-old11',
  '+new12',
  '\\ No newline at end of file',
  ' line12',
  '',
].join('\n')

const SHA = '216381173f187cf4c2baf119193855699f4bc616'
const refs = { baseSha: 'b', startSha: 's', headSha: 'h' }
const file = { oldPath: 'src/app.ts', newPath: 'src/app.ts', hunks: parseHunks(DIFF) }

describe('parseHunks and locateLine', () => {
  test('counts lines like GitLab and maps lines outside hunks', () => {
    const [first, second] = parseHunks(DIFF)
    expect(first?.lines).toEqual([
      { kind: 'context', old: 1, new: 1 },
      { kind: 'removed', old: 2, new: 2 },
      { kind: 'added', old: 3, new: 2 },
      { kind: 'added', old: 3, new: 3 },
      { kind: 'context', old: 3, new: 4 },
      { kind: 'context', old: 4, new: 5 },
    ])
    expect([first?.oldEnd, first?.newEnd, second?.oldEnd, second?.newEnd]).toEqual([5, 6, 13, 14])
    const hunks = parseHunks(DIFF)
    expect(locateLine(hunks, 8, 'new')).toEqual({ kind: 'context', old: 7, new: 8 })
    expect(locateLine(hunks, 20, 'new')).toEqual({ kind: 'context', old: 19, new: 20 })
    expect(locateLine(hunks, 8, 'old')).toEqual({ kind: 'context', old: 8, new: 9 })
    expect(locateLine(hunks, 11, 'old')).toEqual({ kind: 'removed', old: 11, new: 12 })
    expect(locateLine(hunks, 12, 'new')).toEqual({ kind: 'added', old: 12, new: 12 })
  })

  test('line codes are sha1(path)_old_new', () => {
    expect(lineCode('src/app.ts', { kind: 'added', old: 3, new: 2 })).toBe(`${SHA}_3_2`)
  })
})

describe('textPosition', () => {
  test('added, removed and unchanged lines set the matching line fields', () => {
    const base = {
      position_type: 'text',
      base_sha: 'b',
      start_sha: 's',
      head_sha: 'h',
      old_path: 'src/app.ts',
      new_path: 'src/app.ts',
    }
    expect(textPosition(refs, file, { path: 'src/app.ts', line: 3, body: '' })).toEqual({
      ...base,
      new_line: 3,
    })
    expect(
      textPosition(refs, file, { path: 'src/app.ts', line: 2, side: 'old', body: '' }),
    ).toEqual({ ...base, old_line: 2 })
    expect(textPosition(refs, file, { path: 'src/app.ts', line: 5, body: '' })).toEqual({
      ...base,
      old_line: 4,
      new_line: 5,
    })
  })

  test('a range adds line_range with line codes and types', () => {
    const position = textPosition(refs, file, {
      path: 'src/app.ts',
      line: 4,
      startLine: 2,
      body: '',
    })
    expect(position['line_range']).toEqual({
      start: { line_code: `${SHA}_3_2`, type: 'new', new_line: 2 },
      end: { line_code: `${SHA}_3_4`, type: 'old', old_line: 3, new_line: 4 },
    })
    expect([position['old_line'], position['new_line']]).toEqual([3, 4])
  })

  test('without hunks the line is sent on its side only', () => {
    const position = textPosition(
      refs,
      { oldPath: 'a', newPath: 'b' },
      { path: 'b', line: 7, startLine: 6, body: '' },
    )
    expect(position['new_line']).toBe(7)
    expect(position['old_line']).toBeUndefined()
  })
})

describe('renderBody', () => {
  test('appends a suggestion block counting lines above the commented line', () => {
    expect(
      renderBody({
        path: 'a',
        line: 4,
        startLine: 2,
        body: 'Simplify',
        suggestion: { replacement: 'x\ny\n' },
      }),
    ).toBe('Simplify\n\n```suggestion:-2+0\nx\ny\n```')
    expect(renderBody({ path: 'a', line: 1, body: '', suggestion: { replacement: 'z' } })).toBe(
      '```suggestion:-0+0\nz\n```',
    )
    expect(renderBody({ path: 'a', line: 1, body: 'b' })).toBe('b')
  })

  test('uses a longer fence when the replacement has backticks and keeps deletions empty', () => {
    expect(
      renderBody({ path: 'a', line: 1, body: 'Doc', suggestion: { replacement: '```ts\nx\n```' } }),
    ).toBe('Doc\n\n````suggestion:-0+0\n```ts\nx\n```\n````')
    expect(renderBody({ path: 'a', line: 1, body: 'Drop', suggestion: { replacement: '' } })).toBe(
      'Drop\n\n```suggestion:-0+0\n```',
    )
    expect(renderBody({ path: 'a', line: 1, body: '', suggestion: { replacement: '\n' } })).toBe(
      '```suggestion:-0+0\n\n```',
    )
  })
})

describe('invalidReason', () => {
  test('rejects ranges and suggestions GitLab cannot take', () => {
    expect(invalidReason({ path: 'a', line: 2, body: '' })).toBeUndefined()
    expect(invalidReason({ path: 'a', line: 0, body: '' })).toContain('positive')
    expect(invalidReason({ path: 'a', line: 2, startLine: 3, body: '' })).toContain('after')
    expect(
      invalidReason({ path: 'a', line: 2, side: 'old', body: '', suggestion: { replacement: '' } }),
    ).toContain('new version')
    expect(
      invalidReason({
        path: 'a',
        line: 200,
        startLine: 50,
        body: '',
        suggestion: { replacement: '' },
      }),
    ).toContain('101')
  })
})
