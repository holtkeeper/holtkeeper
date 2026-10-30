import { describe, expect, test } from 'bun:test'

import { applyReplacements } from '@holtkeeper/changes'

import { removeExportEdits } from './exports.ts'

function unexport(text: string, names: string[]) {
  const targets = names.map((name) => {
    const index =
      [...text.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g'))].at(-1)?.index ?? -1
    const before = text.slice(0, index)
    const line = before.split('\n').length
    return { name, at: { line, column: index - before.lastIndexOf('\n') } }
  })
  const { edits, removed } = removeExportEdits(text, 'a.ts', targets)
  const result = applyReplacements(text, edits)
  if ('error' in result) throw new Error(result.error)
  return { text: result.text, removed: removed.map((target) => target.name) }
}

describe('removeExportEdits', () => {
  test('drops the export keyword of declarations', () => {
    const source = [
      'export const a = 1',
      'export async function b() {}',
      'export abstract class C {}',
      'export declare const d: number',
      'export type E = string',
      'export interface F {}',
      'export const enum G { X }',
      'export function* h() {}',
      '',
    ].join('\n')
    const { text, removed } = unexport(source, ['a', 'b', 'C', 'd', 'E', 'F', 'G', 'h'])
    expect(text).toBe(source.replaceAll('export ', ''))
    expect(removed).toHaveLength(8)
  })

  test('removes specifiers from export lists, the statement when none is left', () => {
    const source =
      "const a = 1\nconst b = 2\nexport { a, b as c }\nexport type { T } from './t.ts'\n"
    expect(unexport(source, ['a']).text).toContain('export { b as c }')
    expect(unexport(source, ['c']).text).toContain('export { a }')
    expect(unexport(source, ['a', 'c', 'T']).text).toBe('const a = 1\nconst b = 2\n')
  })

  test('keeps multi-line lists tidy', () => {
    const source = 'export {\n  a,\n  b,\n  c,\n}\n'
    expect(unexport(source, ['b']).text).toBe('export {\n  a,\n  c,\n}\n')
    expect(unexport(source, ['b', 'c']).text).toBe('export {\n  a,\n}\n')
    expect(unexport(source, ['a', 'b']).text).toBe('export {\n  c,\n}\n')
  })

  test('un-exports a statement with several declarators only when all of them are unused', () => {
    const source =
      'export const a = 1,\n  b: Map<string, number> = new Map([[x, 1]])\nexport let c = f(1, 2), d = 3;\nconst e = 4\n'
    expect(unexport(source, ['a', 'b', 'c', 'd'])).toEqual({
      text: 'const a = 1,\n  b: Map<string, number> = new Map([[x, 1]])\nlet c = f(1, 2), d = 3;\nconst e = 4\n',
      removed: ['a', 'b', 'c', 'd'],
    })
    expect(unexport(source, ['a', 'd'])).toEqual({ text: source, removed: [] })
    expect(unexport(source, ['b', 'c', 'd']).text).toBe(source.replace('export let', 'let'))
  })

  test('leaves destructuring declarations alone', () => {
    const source = 'export const { a, b } = obj\n'
    expect(unexport(source, ['a', 'b'])).toEqual({ text: source, removed: [] })
  })

  test('skips default exports and positions that do not match the name', () => {
    const source = 'const a = 1\nexport default a\n'
    const { edits, removed } = removeExportEdits(source, 'a.ts', [
      { name: 'default', at: { line: 2, column: 16 } },
      { name: 'zzz', at: { line: 1, column: 7 } },
    ])
    expect(edits).toEqual([])
    expect(removed).toEqual([])
  })
})
