import { describe, expect, test } from 'bun:test'

import { addedLines, parseHunks } from '../../diff.ts'
import { diffOf } from '../run.ts'
import { defineCase, locate } from './build.ts'
import { goldenCases } from './index.ts'

describe('locate', () => {
  test('gives the lines of a snippet, one or several', () => {
    const text = 'a\nb\nc\nd\n'
    expect(locate(text, 'c')).toEqual([3, 3])
    expect(locate(text, 'b\nc')).toEqual([2, 3])
  })

  test('refuses a snippet that is missing or ambiguous', () => {
    expect(() => locate('a\nb\na\n', 'a')).toThrow('exactly once')
    expect(() => locate('a\n', 'z')).toThrow('exactly once')
  })
})

describe('defineCase', () => {
  test('needs the problem to sit in a changed file', () => {
    expect(() =>
      defineCase({
        id: 'x',
        title: 'x',
        merge: { title: 'x', description: '' },
        changes: {},
        problems: [{ id: 'p', path: 'a.ts', find: 'a', note: '' }],
      }),
    ).toThrow('no after version')
  })
})

describe('golden set', () => {
  test('has unique ids and a useful mix of cases', () => {
    const ids = goldenCases.map((testCase) => testCase.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(goldenCases.length).toBeGreaterThanOrEqual(30)
    const clean = goldenCases.filter((testCase) => testCase.expected.length === 0)
    expect(clean.length).toBeGreaterThanOrEqual(8)
    expect(goldenCases.filter((testCase) => testCase.expected.length > 0).length).toBeGreaterThan(
      clean.length,
    )
    expect(goldenCases.some((testCase) => testCase.tests === false)).toBe(true)
  })

  test('names every problem once per case', () => {
    for (const testCase of goldenCases) {
      const ids = testCase.expected.map((expected) => expected.id)
      expect(new Set(ids).size, testCase.id).toBe(ids.length)
    }
  })

  test('every case changes something and every problem sits on a changed line', () => {
    for (const testCase of goldenCases) {
      const files = diffOf(testCase)
      expect(files.length, testCase.id).toBeGreaterThan(0)
      for (const expected of testCase.expected) {
        const file = files.find((candidate) => candidate.newPath === expected.path)
        expect(file, `${testCase.id}/${expected.id}: ${expected.path} is not changed`).toBeDefined()
        const added = addedLines(parseHunks(file?.diff ?? ''))
        const [from, to] = expected.lines
        const touches = Array.from({ length: to - from + 1 }, (_, i) => from + i).some((line) =>
          added.has(line),
        )
        expect(touches, `${testCase.id}/${expected.id}: lines ${from}-${to} are not added`).toBe(
          true,
        )
      }
    }
  })

  test('problems are explained for the people who maintain the set', () => {
    for (const testCase of goldenCases)
      for (const expected of testCase.expected) expect(expected.note.length).toBeGreaterThan(10)
  })
})
