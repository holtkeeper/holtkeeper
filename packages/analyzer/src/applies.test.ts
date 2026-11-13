import { describe, expect, test } from 'bun:test'

import { allOf, anyOf, fileContains, hasFile, hasTreeFile, lockfileHasPackage } from './applies.ts'

const context = (files: Record<string, string>) => ({
  repo: { forge: 'work', path: 'games/app' },
  forge: { readFile: async (_repo: string, path: string) => files[path] },
})

const tree = (paths: string[]) => ({
  repo: { forge: 'work', path: 'shapes/service' },
  forge: {
    readFile: async () => undefined,
    listFiles: async () => paths.map((path) => ({ path, type: 'file' as const })),
  },
})

describe('applicability checks', () => {
  test('hasFile and fileContains read the default branch', async () => {
    const files = context({ '.browserslistrc': 'defaults', 'package.json': '{"browserslist":[]}' })
    expect(await hasFile('missing', '.browserslistrc')(files)).toBe(true)
    expect(await hasFile('missing')(files)).toBe(false)
    expect(await fileContains(['package.json'], '"browserslist"')(files)).toBe(true)
    expect(await fileContains(['package.json'], /"eslint"/)(files)).toBe(false)
  })

  test('lockfileHasPackage finds the package in every lockfile format', async () => {
    const lockfiles: Record<string, string> = {
      'bun.lock': '    "caniuse-lite": ["caniuse-lite@1.0.30001700", "", {}, "sha512"],',
      'pnpm-lock.yaml': 'packages:\n  caniuse-lite@1.0.30001700:\n    resolution: {}',
      'yarn.lock': 'caniuse-lite@^1.0.30001688:\n  version "1.0.30001700"',
      'package-lock.json': '    "node_modules/caniuse-lite": {\n      "version": "1.0.30001700"',
    }
    for (const [path, text] of Object.entries(lockfiles))
      expect(await lockfileHasPackage('caniuse-lite')(context({ [path]: text }))).toBe(true)
    expect(
      await lockfileHasPackage('caniuse-lite')(
        context({ 'bun.lock': '"not-caniuse-lite": ["not-caniuse-lite@1.0.0"]' }),
      ),
    ).toBe(false)
    expect(await lockfileHasPackage('caniuse-lite')(context({}))).toBe(false)
  })

  test('anyOf and allOf combine checks', async () => {
    const files = context({ 'go.mod': 'module x' })
    expect(await anyOf(hasFile('package.json'), hasFile('go.mod'))(files)).toBe(true)
    expect(await allOf(hasFile('package.json'), hasFile('go.mod'))(files)).toBe(false)
  })

  test('hasTreeFile looks through the tree outside skipped folders', async () => {
    const html = hasTreeFile((path) => path.endsWith('.html'))
    expect(await html(tree(['go.mod', 'web/templates/index.html']))).toBe(true)
    expect(await html(tree(['go.mod', 'cmd/app/main.go']))).toBe(false)
    expect(await html(tree(['vendor/x/doc.html', 'node_modules/y/a.html', '.cache/z.html']))).toBe(
      false,
    )
    expect(await html(tree(Array.from({ length: 10_000 }, (_, i) => `f${i}.go`)))).toBe(true)
    expect(
      await html({
        repo: { forge: 'work', path: 'a/b' },
        forge: { readFile: async () => undefined },
      }),
    ).toBe(true)
  })
})
