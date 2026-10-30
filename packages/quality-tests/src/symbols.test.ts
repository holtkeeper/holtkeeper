import { describe, expect, test } from 'bun:test'

import { codeLines, findFunctions, isTypeOnlySource, maskSource } from './symbols.ts'

const TS = `import { x } from './x.ts'
// function fake() {}
const s = "function alsoFake() {"
export async function createSession(id: string, opts: { a: number } = { a: 1 }): Promise<void> {
  if (!id) throw new Error('}')
  const re = /\\{+/g
  const t = \`\${id} } \${opts.a > 1 ? 'x' : 'y'}\`
  return
}

export const sub = (a: number, b: number) => {
  if (a > b && b > 0) return a - b
  return b - a
}

export const double = (n: number) =>
  n * 2

const notFn = (1 + 2)
const obj = { a: () => 1 }
function overload(a: string): void
function overload(a: unknown) {
  return a
}

export class Store<T> extends Base {
  private items: T[] = []
  constructor() { super() }
  async get(id: string): Promise<T | undefined> {
    for (const item of this.items) {
      if (item) return item
    }
  }
  static create = (x: number) => {
    return new Store()
  }
  abstract thing(): void;
}
`

describe('findFunctions', () => {
  test('finds TypeScript functions, arrows and methods, ignoring strings, comments and overloads', () => {
    expect(
      findFunctions(TS, 'js').map((fn) => [
        fn.name,
        fn.kind,
        fn.startLine,
        fn.endLine,
        fn.branches,
      ]),
    ).toEqual([
      ['createSession', 'function', 4, 9, 2],
      ['sub', 'function', 11, 14, 2],
      ['double', 'function', 16, 17, 0],
      ['overload', 'function', 22, 24, 0],
      ['Store.get', 'method', 29, 33, 2],
      ['Store.create', 'method', 34, 36, 0],
    ])
  })

  test('finds Go functions and methods', () => {
    const go =
      'package x\n\nfunc (s *Server) Handle(w int) error {\n\tif w > 0 && w < 3 {\n\t\treturn nil\n\t}\n\treturn fmt.Errorf("}")\n}\n\nfunc New[T any](x T) *Server {\n\treturn &Server{}\n}\n'
    expect(
      findFunctions(go, 'go').map((fn) => [
        fn.name,
        fn.kind,
        fn.startLine,
        fn.endLine,
        fn.branches,
      ]),
    ).toEqual([
      ['Server.Handle', 'method', 3, 8, 2],
      ['New', 'function', 10, 12, 0],
    ])
  })

  test('finds Python functions and methods, not nested ones', () => {
    const py =
      'def top(a, b):\n    """Doc\nwith } stuff"""\n    if a:\n        return b\n    return a\n\nclass Foo:\n    def m(self):\n        def inner():\n            pass\n        return 1\n\nx = 1\n'
    expect(
      findFunctions(py, 'python').map((fn) => [fn.name, fn.kind, fn.startLine, fn.endLine]),
    ).toEqual([
      ['top', 'function', 1, 6],
      ['Foo.m', 'method', 9, 12],
    ])
  })
})

describe('helpers', () => {
  test('maskSource keeps length and newlines', () => {
    const masked = maskSource('a = "x{y}" // }\nb', 'js')
    expect(masked).toHaveLength(17)
    expect(masked).toBe('a = "    "     \nb')
  })

  test('codeLines skips blank and comment lines', () => {
    expect(codeLines('a\n\n// c\nb\n', 'js', 1, 4)).toBe(2)
  })

  test('isTypeOnlySource', () => {
    expect(
      isTypeOnlySource(
        "import type { A } from './a.ts'\nexport interface B {\n  run(): void\n}\nexport type C =\n  | 'x'\n  | 'y'\n",
      ),
    ).toBe(true)
    expect(isTypeOnlySource('export type A = 1\nexport const b = 2\n')).toBe(false)
    expect(isTypeOnlySource("export * from './a.ts'\n")).toBe(false)
  })
})
