import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { parseJscpdReport } from './report.ts'

const captured = await Bun.file(join(import.meta.dir, '../test/jscpd-report.json')).text()

describe('parseJscpdReport', () => {
  test('reads a captured jscpd 5 report', () => {
    const { duplication, issues } = parseJscpdReport(captured)
    expect(duplication).toEqual({ percentage: 50, duplicatedLines: 13, totalLines: 26 })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      tool: 'jscpd',
      rule: 'clone/exact',
      category: 'duplication',
      severity: 'info',
      file: 'src/a.ts',
      message: '13 lines (93 tokens) duplicated in src/a.ts:1-13 and src/b.ts:1-13',
      range: { start: { line: 1, column: 1 }, end: { line: 14, column: 1 } },
    })
    expect(issues[0]?.help).toContain('src/b.ts:1-13')
  })

  test('large clones are warnings', () => {
    expect(parseJscpdReport(captured, { lines: 10 }).issues[0]?.severity).toBe('warning')
    expect(parseJscpdReport(captured, { tokens: 90 }).issues[0]?.severity).toBe('warning')
  })

  test('ids ignore where the clone moved', () => {
    const report = JSON.parse(captured)
    const before = parseJscpdReport(report).issues[0]?.id
    report.duplicates[0].firstFile.start += 3
    report.duplicates[0].firstFile.end += 3
    report.duplicates[0].firstFile.name = './src/a.ts'
    expect(parseJscpdReport(report).issues[0]?.id).toBe(before)
  })

  test('repeats of one clone between the same files get distinct ids', () => {
    const report = JSON.parse(captured)
    const again = structuredClone(report.duplicates[0])
    again.secondFile.start += 40
    again.secondFile.end += 40
    report.duplicates.push(again)
    const [first, second] = parseJscpdReport(report).issues
    expect(first?.id).toBe(parseJscpdReport(captured).issues[0]?.id)
    expect(second?.id).not.toBe(first?.id)
  })

  test('rejects other shapes', () => {
    expect(() => parseJscpdReport({ clones: [] })).toThrow()
  })
})
