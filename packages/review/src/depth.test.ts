import { describe, expect, test } from 'bun:test'

import { DEFAULT_DEEP_FROM_MINUTES, resolveReviewDepth } from './depth.ts'
import type { FileScope } from './scope.ts'

const added = (path: string, count: number): FileScope => ({
  path,
  oldPath: path,
  status: 'modified',
  hunks: [
    {
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: count,
      lines: Array.from({ length: count }, (_, i) => ({
        kind: 'add' as const,
        text: `const widget${i} = makeWidget(${i})`,
        newLine: i + 1,
      })),
    },
  ],
  lines: new Set(Array.from({ length: count }, (_, i) => i + 1)),
  visible: new Map(),
})

describe('resolveReviewDepth', () => {
  test('standard and deep do not look at the size', () => {
    expect(resolveReviewDepth('standard', [added('src/widget.ts', 2000)])).toEqual({ deep: false })
    expect(resolveReviewDepth('deep', [added('src/widget.ts', 1)])).toEqual({ deep: true })
  })

  test('auto reviews small changes on main and large ones on deep', () => {
    // 10 to understand + 40 lines at 400 an hour (6) + half a minute for the file
    expect(resolveReviewDepth('auto', [added('src/widget.ts', 40)])).toEqual({
      deep: false,
      minutes: 17,
    })
    const large = resolveReviewDepth('auto', [added('src/widget.ts', 400)])
    expect(large.deep).toBe(true)
    expect(large.minutes).toBeGreaterThanOrEqual(DEFAULT_DEEP_FROM_MINUTES)
  })

  test('tests weigh half, and the threshold is configurable', () => {
    // 400 test lines read like 200 lines of code: 10 + 30 + 0.5
    expect(resolveReviewDepth('auto', [added('src/__tests__/widget.test.ts', 400)])).toEqual({
      deep: false,
      minutes: 41,
    })
    expect(resolveReviewDepth('auto', [added('src/widget.ts', 40)], 15).deep).toBe(true)
  })
})
