import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { codeTools, jsModuleGraph, type ModuleGraphLoader } from '../src/index.ts'
import { call, createFixture, type Fixture } from './fixture.ts'

let fixture: Fixture
beforeAll(async () => {
  fixture = await createFixture()
})
afterAll(() => fixture.cleanup())

const code = codeTools()
const run = (name: string, input: Record<string, unknown>) => call(code, name, input, fixture.ctx)

describe('code.search', () => {
  test('returns file:line and the snippet of each match', async () => {
    expect(await run('code.search', { pattern: 'formatName($A)', language: 'typescript' })).toBe(
      'src/index.ts:6\n  formatName(user.name)',
    )
  })

  test('respects path globs and languages', async () => {
    expect(
      await run('code.search', {
        pattern: 'new $C($$$)',
        language: 'typescript',
        paths: ['src/util.ts'],
      }),
    ).toStartWith('no matches in 1 typescript files')
    expect(await run('code.search', { pattern: 'main($$$)', language: 'tsx' })).toStartWith(
      'src/view.tsx:3',
    )
  })

  test('caps hits and long snippets', async () => {
    const small = codeTools({ budget: { maxHits: 3, snippetLines: 1 } })
    const out = await call(
      small,
      'code.search',
      { pattern: 'export const $A = $B', language: 'typescript' },
      fixture.ctx,
    )
    expect(out.split('\n')).toHaveLength(7)
    expect(out).toEndWith('… 297 more matches')
    const multi = await call(
      small,
      'code.search',
      { pattern: 'class $A { $$$ }', language: 'typescript' },
      fixture.ctx,
    )
    expect(multi).toContain('… 9 more lines')
  })

  test('never searches node_modules', async () => {
    expect(await run('code.search', { pattern: 'leftPad', language: 'typescript' })).toStartWith(
      'no matches',
    )
  })
})

describe('code.grep', () => {
  test('groups matches by file with context', async () => {
    const out = await run('code.grep', { query: 'formatName', context: 1 })
    expect(out).toStartWith('4 matches in 2 files\nsrc/index.ts\n  1: import { formatName')
    expect(out).toContain('  2- import type { User }')
    expect(out).toContain('  --')
    expect(out).toContain('  12:     // TODO: localize formatName output')
  })

  test('supports regular expressions and case folding', async () => {
    expect(await run('code.grep', { query: 'todo: LOCALIZE', ignoreCase: true })).toContain(
      'src/util.ts',
    )
    expect(await run('code.grep', { query: '^export type \\w+', regex: true })).toContain(
      '6: export type Id',
    )
    expect(run('code.grep', { query: '(', regex: true })).rejects.toThrow('invalid regex')
  })

  test('truncates to the line budget', async () => {
    const small = codeTools({ budget: { maxResultLines: 10 } })
    const out = await call(small, 'code.grep', { query: 'export const value' }, fixture.ctx)
    const lines = out.split('\n')
    expect(lines.length).toBeLessThanOrEqual(10)
    expect(lines[0]).toBe('300 matches in 1 files')
    expect(lines.at(-1)).toMatch(/^… \d+ more|^  \d+: /)
  })
})

describe('code.outline', () => {
  test('lists declarations with members and line ranges', async () => {
    expect(await run('code.outline', { path: 'src/util.ts' })).toBe(
      [
        'src/util.ts (15 lines)',
        '2-4 export function formatName(name: string): string',
        '6-15 export class Greeter',
        '  7 prefix: string',
        '  8-10 constructor(prefix: string)',
        '  11-14 greet(name: string): string',
      ].join('\n'),
    )
    expect(await run('code.outline', { path: 'src/index.ts' })).toContain(
      '1-2 imports (2): ./util.ts, ./model.ts',
    )
  })

  test('truncates long outlines and rejects other files', async () => {
    const small = codeTools({ budget: { maxResultLines: 20 } })
    const out = await call(small, 'code.outline', { path: 'src/big.ts' }, fixture.ctx)
    expect(out.split('\n')).toHaveLength(20)
    expect(out).toEndWith('… 282 more symbols')
    expect(run('code.outline', { path: 'package.json' })).rejects.toThrow('supports TypeScript')
    expect(run('code.outline', { path: '../etc/passwd.ts' })).rejects.toThrow(
      'outside the working directory',
    )
  })
})

describe('code.symbol and code.references', () => {
  test('finds definitions', async () => {
    expect(await run('code.symbol', { name: 'formatName' })).toBe(
      'src/util.ts:2-4 export function formatName(name: string): string',
    )
    expect(await run('code.symbol', { name: 'Id' })).toBe(
      'src/model.ts:6 export type Id = string | number',
    )
    expect(await run('code.symbol', { name: 'greet' })).toBe(
      'src/util.ts:11-14 greet(name: string): string',
    )
    expect(await run('code.symbol', { name: 'View' })).toStartWith(
      'src/view.tsx:3 export const View',
    )
    expect(await run('code.symbol', { name: 'missing' })).toBe('no definitions of missing')
    expect(run('code.symbol', { name: 'a.b' })).rejects.toThrow('not an identifier')
  })

  test('finds usages without definitions, comments or strings', async () => {
    expect(await run('code.references', { name: 'formatName' })).toBe(
      [
        '2 lines in 1 files',
        'src/index.ts',
        "  1: import { formatName, Greeter } from './util.ts'",
        '  6: return greeter.greet(formatName(user.name))',
      ].join('\n'),
    )
    const id = await run('code.references', { name: 'Id' })
    expect(id).toContain('src/model.ts\n  2: id: Id')
    expect(id).not.toContain('6: export type Id')
  })
})

describe('code.read', () => {
  test('reads a numbered range', async () => {
    expect(await run('code.read', { path: 'src/util.ts', start: 2, end: 4 })).toBe(
      [
        'src/util.ts 2-4 of 15',
        '2| export function formatName(name: string): string {',
        '3|   return name.trim()',
        '4| }',
        '… 11 more lines in the file (continue with start=5)',
      ].join('\n'),
    )
  })

  test('enforces the line limit', async () => {
    const small = codeTools({ budget: { maxResultLines: 12 } })
    const out = await call(
      small,
      'code.read',
      { path: 'src/big.ts', start: 1, end: 300 },
      fixture.ctx,
    )
    const lines = out.split('\n')
    expect(lines).toHaveLength(12)
    expect(lines[0]).toBe('src/big.ts 1-10 of 300')
    expect(lines.at(-1)).toBe('… 290 more lines in the file (continue with start=11)')
    expect(await run('code.read', { path: 'src/util.ts', start: 99 })).toBe(
      'src/util.ts has 15 lines',
    )
  })

  test('refuses paths outside the checkout, symlinks included', async () => {
    expect(run('code.read', { path: '/etc/hosts' })).rejects.toThrow('outside')
    await symlink('/etc', join(fixture.dir, 'escape'))
    expect(run('code.read', { path: 'escape/hosts' })).rejects.toThrow('outside')
  })
})

describe('code.dependents and code.dependencies', () => {
  test('walk the import graph', async () => {
    expect(await run('code.dependents', { path: 'src/util.ts' })).toBe(
      '1 dependents of src/util.ts\nsrc/index.ts',
    )
    expect(await run('code.dependents', { path: 'src/util.ts', depth: 2 })).toBe(
      '2 dependents of src/util.ts\n1 src/index.ts\n2 src/view.tsx',
    )
    expect(await run('code.dependencies', { path: 'src/view.tsx', depth: 2 })).toBe(
      '2 dependencies of src/view.tsx\n1 src/index.ts\n2 src/util.ts',
    )
    expect(await run('code.dependents', { path: 'src/view.tsx' })).toBe(
      'nothing imports src/view.tsx',
    )
    expect(await run('code.dependents', { path: 'README.md' })).toContain('not in the module graph')
  })

  test('build the graph once per toolset', async () => {
    let loads = 0
    const counting: ModuleGraphLoader = async (dir) => {
      loads++
      return jsModuleGraph(dir)
    }
    const tools = codeTools({ moduleGraph: counting })
    await call(tools, 'code.dependents', { path: 'src/util.ts' }, fixture.ctx)
    await call(tools, 'code.dependencies', { path: 'src/index.ts' }, fixture.ctx)
    expect(loads).toBe(1)
  })
})
