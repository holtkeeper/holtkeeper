import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { extractUsages, usagesDataSchema, usagesReport } from '../src/index.ts'

const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'game', dependencies: { '@acme/ui': '^3.0.0' } }),
  'package-lock.json': JSON.stringify({
    name: 'game',
    lockfileVersion: 3,
    packages: {
      '': { name: 'game', dependencies: { '@acme/ui': '^3.0.0' } },
      'node_modules/@acme/ui': { version: '3.2.1' },
    },
  }),
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      jsx: 'preserve',
      strict: true,
      module: 'preserve',
      moduleResolution: 'bundler',
      noEmit: true,
      types: [],
    },
    include: ['src'],
  }),
  'node_modules/@acme/ui/package.json': JSON.stringify({
    name: '@acme/ui',
    version: '3.2.1',
    types: 'index.d.ts',
  }),
  'node_modules/@acme/ui/index.d.ts': `
export interface ButtonProps { variant?: 'primary' | 'ghost'; onPress?: () => void }
export declare function Button(props: ButtonProps): unknown
export interface Store { score: number; reset(): void }
export declare function useStore(): Store
`,
  'src/kit.ts': `export { Button as GameButton } from '@acme/ui'\n`,
  'src/game.tsx': `// Игра: смещения в UTF-16 🎮
import { useStore } from '@acme/ui'
import { GameButton } from './kit'

export function Game() {
  const store = useStore()
  store.reset()
  return <GameButton variant="ghost" onPress={() => store.score} />
}
`,
}

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usages-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
})

afterAll(() => rm(dir, { recursive: true, force: true }))

describe('extractUsages', () => {
  test('follows imports without the type checker', async () => {
    const data = await extractUsages({ dir, types: false })
    expect(usagesDataSchema.safeParse(data).success).toBe(true)
    expect(data.types).toEqual({ status: 'skipped', reason: 'turned off' })
    const [ui] = data.packages
    expect(ui).toMatchObject({ name: '@acme/ui', versions: ['3.2.1'], ranges: ['^3.0.0'] })
    expect(
      ui?.exports.map((item) => `${item.name}:${Object.keys(item.kinds).join(',')}`).toSorted(),
    ).toEqual(['Button:reexport', 'useStore:call'])
    const site = ui?.exports.find((item) => item.name === 'useStore')?.sites[0]
    expect(site).toMatchObject({ file: 'src/game.tsx', line: 6, column: 17 })
    expect(site?.snippet).toContain('const store = useStore()')
  })

  test('resolves what imports do not show with the type checker', async () => {
    const data = await extractUsages({ dir })
    expect(data.types.status).toBe('used')
    expect(data.types.projects).toEqual(['tsconfig.json'])
    const ui = data.packages.find((pkg) => pkg.name === '@acme/ui')
    const store = ui?.exports.find((item) => item.name === 'Store')
    expect(store?.members.map((m) => m.name).toSorted()).toEqual(['reset', 'score'])
    expect(store?.sites.every((site) => site.typed)).toBe(true)
    const reset = store?.sites.find((site) => site.member === 'reset')
    expect(reset).toMatchObject({ kind: 'call', line: 7, column: 9 })
    const button = ui?.exports.find((item) => item.name === 'Button')
    expect(button?.kinds).toMatchObject({ jsx: 1, reexport: 1 })
    expect(button?.props.map((p) => p.name).toSorted()).toEqual(['onPress', 'variant'])
    const report = usagesReport(data)
    expect(report.metrics.find((m) => m.id === 'typed')?.value).toBe(data.types.sites ?? -1)
  })
})
