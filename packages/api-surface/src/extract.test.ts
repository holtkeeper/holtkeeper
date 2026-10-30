import { afterAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { extractApi } from './extract.ts'

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

async function checkout(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'api-surface-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

const json = (value: unknown) => JSON.stringify(value)

test('reads workspaces, exports subpaths and re-exports across files', async () => {
  const dir = await checkout({
    'package.json': json({ name: 'root', private: true, workspaces: ['packages/*'] }),
    'packages/ui/package.json': json({
      name: '@acme/ui',
      version: '1.2.0',
      description: 'Buttons',
      exports: {
        '.': './src/index.ts',
        './button': { types: './dist/button.d.ts', import: './dist/button.js' },
      },
    }),
    'packages/ui/src/index.ts': [
      "export * from './math.ts'",
      "export { Button as PrimaryButton } from './button.ts'",
      "export * as helpers from './helpers.js'",
      "export * from 'other-lib'",
      "import { local } from './helpers.ts'",
      'export { local }',
    ].join('\n'),
    'packages/ui/src/math.ts': [
      '/** Adds two numbers. */',
      'export function add(a: number, b = 1): number {',
      '  return a + b',
      '}',
      '/**',
      ' * Old.',
      ' * @deprecated use add',
      ' */',
      'export const plus = (a: number, b: number): number => a + b',
      'export function over(a: string): string',
      'export function over(a: number): number',
      'export function over(a: unknown) { return a }',
    ].join('\n'),
    'packages/ui/src/button.ts': [
      '/** A button. */',
      'export class Button<T> extends Base {',
      '  #secret = 1',
      '  private hidden = 2',
      '  /** Its label. */',
      '  label: string = "ok"',
      '  constructor(readonly id: T) { super() }',
      '  click(times = 1): void { console.log(times) }',
      '}',
      'declare class Base {}',
    ].join('\n'),
    'packages/ui/src/helpers.ts': 'export const local = 1\nexport type Id = string',
    'packages/ui/dist/button.d.ts': 'export declare function button(): void',
    'packages/no-entry/package.json': json({ name: 'no-entry', main: 'dist/index.js' }),
  })

  const packages = await extractApi({ dir })
  expect(packages.map((pkg) => pkg.name)).toEqual(['@acme/ui'])
  const [ui] = packages
  expect(ui).toMatchObject({
    version: '1.2.0',
    description: 'Buttons',
    private: false,
    dir: 'packages/ui',
  })
  const [main, button] = ui?.entries ?? []
  expect(main?.file).toBe('packages/ui/src/index.ts')
  expect(main?.symbols.map((symbol) => symbol.name)).toEqual([
    '*',
    'add',
    'helpers',
    'local',
    'over',
    'plus',
    'PrimaryButton',
  ])
  const byName = new Map(main?.symbols.map((symbol) => [symbol.name, symbol]))
  expect(byName.get('add')).toMatchObject({
    kind: 'function',
    signature: 'function add(a: number, b = 1): number',
    doc: 'Adds two numbers.',
    file: 'packages/ui/src/math.ts',
    line: 2,
  })
  expect(byName.get('plus')).toMatchObject({
    kind: 'variable',
    signature: 'const plus = (a: number, b: number): number => …',
    deprecated: 'use add',
  })
  expect(byName.get('over')?.signature).toBe(
    'function over(a: string): string\nfunction over(a: number): number\nfunction over(a: unknown)',
  )
  expect(byName.get('PrimaryButton')?.signature).toBe(
    'class Button<T> extends Base {\n  /** Its label. */\n  label: string\n  constructor(readonly id: T)\n  click(times = 1): void\n}',
  )
  expect(byName.get('helpers')?.signature).toBe('namespace helpers { local, Id }')
  expect(byName.get('*')).toMatchObject({
    kind: 'reexport',
    signature: "export * from 'other-lib'",
  })
  expect(button).toMatchObject({ subpath: './button', file: 'packages/ui/dist/button.d.ts' })
  expect(button?.symbols[0]?.signature).toBe('function button(): void')
})

test('maps a missing build output back to its TypeScript source', async () => {
  const dir = await checkout({
    'package.json': json({ name: 'lib', version: '0.3.0', main: './dist/index.js', private: true }),
    'src/index.ts':
      '// oxlint-disable-next-line\nexport default function make() {}\nexport type { Opt } from "./types"',
    'src/types.ts':
      '/** Options. */\n// eslint-disable-next-line\nexport interface Opt { a?: string }',
  })
  const [lib] = await extractApi({ dir })
  expect(lib?.entries[0]?.file).toBe('src/index.ts')
  expect(lib?.entries[0]?.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.doc])).toEqual([
    ['default', 'function', undefined],
    ['Opt', 'interface', 'Options.'],
  ])
  expect(await extractApi({ dir, includePrivate: false })).toEqual([])
  expect(await extractApi({ dir, packages: ['@acme/*'] })).toEqual([])
})
