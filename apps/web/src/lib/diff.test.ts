import { describe, expect, test } from 'bun:test'

import type { DiffHunk } from '@holtkeeper/api'

import { diffStats, hunkHeader, splitRows, unifiedRows } from './diff.ts'

const hunk: DiffHunk = {
  oldStart: 10,
  oldLines: 4,
  newStart: 10,
  newLines: 5,
  lines: [
    { kind: 'context', text: 'a' },
    { kind: 'remove', text: 'b' },
    { kind: 'remove', text: 'c' },
    { kind: 'add', text: 'B' },
    { kind: 'add', text: 'C' },
    { kind: 'add', text: 'D' },
    { kind: 'context', text: 'e' },
  ],
}

describe('diff rows', () => {
  test('unified rows carry old and new numbers', () => {
    expect(unifiedRows(hunk)).toEqual([
      { kind: 'context', text: 'a', old: 10, new: 10 },
      { kind: 'remove', text: 'b', old: 11 },
      { kind: 'remove', text: 'c', old: 12 },
      { kind: 'add', text: 'B', new: 11 },
      { kind: 'add', text: 'C', new: 12 },
      { kind: 'add', text: 'D', new: 13 },
      { kind: 'context', text: 'e', old: 13, new: 14 },
    ])
  })

  test('split rows pair removals with following additions', () => {
    const rows = splitRows(hunk)
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', 'C'],
      [null, 'D'],
      ['e', 'e'],
    ])
    expect(rows[4]).toEqual({
      left: { no: 13, text: 'e', kind: 'context' },
      right: { no: 14, text: 'e', kind: 'context' },
    })
  })

  test('an addition before a removal does not pair backwards', () => {
    const rows = splitRows({
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [
        { kind: 'add', text: 'x' },
        { kind: 'remove', text: 'y' },
      ],
    })
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      [null, 'x'],
      ['y', null],
    ])
  })

  test('header and stats', () => {
    expect(hunkHeader(hunk)).toBe('@@ -10,4 +10,5 @@')
    expect(diffStats([{ file: 'a.ts', status: 'modified', hunks: [hunk] }])).toEqual({
      added: 3,
      removed: 2,
      files: 1,
    })
  })
})
