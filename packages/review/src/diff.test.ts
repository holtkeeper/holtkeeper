import { describe, expect, test } from 'bun:test'

import {
  addedLines,
  changedLineCount,
  nearestLine,
  newSideLines,
  parseHunks,
  renderNumberedDiff,
} from './diff.ts'

const diff = `--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,5 @@ function f() {
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5

\\ No newline at end of file
@@ -20,2 +21,3 @@
 x
+y
 z
`

describe('parseHunks', () => {
  test('numbers lines on both sides', () => {
    const hunks = parseHunks(diff)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]?.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 1, 1],
      ['remove', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['context', 3, 4],
      ['context', 4, 5],
    ])
    expect([...addedLines(hunks)]).toEqual([2, 3, 22])
    expect(newSideLines(hunks).get(22)).toBe('y')
    expect(newSideLines(hunks).has(1)).toBe(true)
    expect(changedLineCount(hunks)).toBe(4)
  })

  test('reads headers without counts', () => {
    const [hunk] = parseHunks('@@ -1 +1 @@\n-a\n+b\n')
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 })
  })
})

test('nearestLine prefers the closest, then the earlier line', () => {
  expect(nearestLine([2, 6], 4, 5)).toBe(2)
  expect(nearestLine([2, 5], 4, 5)).toBe(5)
  expect(nearestLine([20], 4, 5)).toBeUndefined()
})

test('renderNumberedDiff marks in-scope and already reviewed lines', () => {
  const hunks = parseHunks(diff)
  const text = renderNumberedDiff('a.ts', hunks, new Set([3]))
  expect(text).toContain('### a.ts')
  expect(text).toContain(' 2 ~ const b = 3')
  expect(text).toContain(' 3 + const c = 4')
  expect(text).toContain('   - const b = 2')
  expect(text).not.toContain('y')
  expect(renderNumberedDiff('a.ts', hunks, new Set())).toBe('')
})
