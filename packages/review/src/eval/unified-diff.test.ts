import { describe, expect, test } from 'bun:test'

import { parseHunks } from '../diff.ts'
import { unifiedDiff } from './unified-diff.ts'

const text = (...lines: string[]) => `${lines.join('\n')}\n`

/** Applies parsed hunks of `diff` to `before`, the way `patch` would. */
function apply(before: string, diff: string): string {
  const old = before === '' ? [] : before.replace(/\n$/, '').split('\n')
  const result: string[] = []
  let at = 0
  for (const hunk of parseHunks(diff)) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    result.push(...old.slice(at, start))
    at = start
    for (const line of hunk.lines) {
      if (line.kind === 'add') result.push(line.text)
      else at++
      if (line.kind === 'context') result.push(line.text)
    }
  }
  result.push(...old.slice(at))
  return result.length ? `${result.join('\n')}\n` : ''
}

describe('unifiedDiff', () => {
  test('is empty for equal texts', () => {
    expect(unifiedDiff(text('a', 'b'), text('a', 'b'))).toBe('')
    expect(unifiedDiff('', '')).toBe('')
  })

  test('a new file is one hunk of additions', () => {
    const diff = unifiedDiff('', text('a', 'b'))
    expect(diff).toBe('@@ -0,0 +1,2 @@\n+a\n+b\n')
    expect(parseHunks(diff)[0]).toMatchObject({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
    })
  })

  test('a deleted file is one hunk of removals', () => {
    expect(unifiedDiff(text('a', 'b'), '')).toBe('@@ -1,2 +0,0 @@\n-a\n-b\n')
  })

  test('numbers a change in the middle with three lines of context', () => {
    const before = text('1', '2', '3', '4', '5', '6', '7', '8', '9')
    const after = text('1', '2', '3', '4', 'five', '6', '7', '8', '9')
    expect(unifiedDiff(before, after)).toBe('@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n')
  })

  test('changes far apart make separate hunks, near ones share a hunk', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const far = before.map((line, i) => (i === 2 || i === 25 ? `${line}!` : line))
    expect(parseHunks(unifiedDiff(text(...before), text(...far)))).toHaveLength(2)
    const near = before.map((line, i) => (i === 2 || i === 6 ? `${line}!` : line))
    expect(parseHunks(unifiedDiff(text(...before), text(...near)))).toHaveLength(1)
  })

  test('applying the diff to the old text gives the new text', () => {
    const cases: [string, string][] = [
      [text('a', 'b', 'c'), text('a', 'c')],
      [text('a', 'c'), text('a', 'b', 'c', 'd')],
      [text('x'), text('y')],
      [
        text('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'),
        text('zero', 'one', 'three', 'four', 'five', 'six', 'seven', 'eight', 'ten', 'eleven'),
      ],
      ['', text('only')],
      [text('only'), ''],
    ]
    for (const [before, after] of cases)
      expect(apply(before, unifiedDiff(before, after))).toBe(after)
  })

  test('a text without a final newline diffs like one with it', () => {
    expect(unifiedDiff('a\nb', 'a\nc')).toBe(unifiedDiff('a\nb\n', 'a\nc\n'))
  })
})
