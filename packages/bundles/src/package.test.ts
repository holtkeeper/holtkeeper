import { expect, test } from 'bun:test'

import { targetReport } from './analysis.ts'
import { MAX_PACKAGE_ENTRIES, analyzePackage, packageEntries } from './package.ts'

const encode = (text: string) => new TextEncoder().encode(text)

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, encode(text)]))

test('package entries follow browser conditions, skip types and expand patterns', () => {
  const archive = new Set([
    'dist/index.mjs',
    'dist/index.cjs',
    'dist/index.d.ts',
    'dist/icons/a.js',
    'dist/icons/b.js',
    'dist/utils.js',
  ])
  const entries = packageEntries(
    {
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.mjs',
          require: './dist/index.cjs',
        },
        './utils': './dist/utils',
        './icons/*': { default: './dist/icons/*.js' },
        './package.json': './package.json',
        './missing': './dist/missing.js',
      },
    },
    archive,
  )
  expect(entries).toEqual([
    { name: '.', initial: ['dist/index.mjs'], lazy: [] },
    { name: './utils', initial: ['dist/utils.js'], lazy: [] },
    { name: './icons/a', initial: ['dist/icons/a.js'], lazy: [] },
    { name: './icons/b', initial: ['dist/icons/b.js'], lazy: [] },
  ])
  expect(
    packageEntries({ main: 'lib/main.js', module: 'lib/esm.js' }, new Set(['lib/esm.js'])),
  ).toEqual([{ name: '.', initial: ['lib/esm.js'], lazy: [] }])
})

test('measures a published version: shipped files, entry closure and archive weight', async () => {
  const target = await analyzePackage({
    name: '@acme/ui',
    version: '2.1.0',
    publishedAt: '2026-03-01T00:00:00Z',
    files: files({
      'package.json': JSON.stringify({
        name: '@acme/ui',
        version: '2.1.0',
        exports: { '.': './dist/index.js', './button': './dist/button.js' },
        dependencies: { clsx: '^2.0.0' },
        peerDependencies: { react: '^19.0.0' },
      }),
      'dist/index.js': "import { button } from './button.js'\nexport const ui = () => button()\n",
      'dist/button.js': `export const button = () => ${JSON.stringify('x'.repeat(2000))}\n`,
      'dist/index.d.ts': 'export declare const ui: () => string\n',
      'README.md': '# ui\n',
    }),
  })
  expect(target).toMatchObject({
    name: '@acme/ui',
    source: 'package',
    version: '2.1.0',
    at: '2026-03-01T00:00:00Z',
    status: 'ok',
    package: { files: 5, dependencies: ['clsx'], peerDependencies: ['react'] },
  })
  expect(target.data?.assets.map((asset) => asset.file)).toEqual([
    'dist/button.js',
    'dist/index.js',
  ])
  const root = target.data?.entrypoints.find((entry) => entry.name === '.')
  expect(root?.initial.toSorted()).toEqual(['dist/button.js', 'dist/index.js'])
  expect(target.package?.unpacked).toBeGreaterThan(2000)
})

test('a broken manifest becomes a failed target', async () => {
  const target = await analyzePackage({
    name: 'broken',
    version: '1.0.0',
    files: files({ 'package.json': '{ nope' }),
  })
  expect(target.status).toBe('failed')
  expect(target.error).toBeString()
})

test('explicit subpaths come before pattern expansions under the cap', () => {
  const icons = Array.from({ length: 150 }, (_, index) => `dist/icons/i${index}.js`)
  const entries = packageEntries(
    { exports: { './icons/*': './dist/icons/*.js', '.': './dist/index.js' } },
    new Set(['dist/index.js', ...icons]),
  )
  expect(entries).toHaveLength(100)
  expect(entries[0]?.name).toBe('.')
})

test('packages without declared entries are measured by their modules nothing else imports', async () => {
  const target = await analyzePackage({
    name: 'hooks',
    version: '0.4.3',
    files: files({
      'package.json': JSON.stringify({ name: 'hooks', version: '0.4.3' }),
      'useTabKey.js':
        "import { KEY } from './registry/constants.js'\nexport const useTabKey = () => KEY\n",
      'registry/constants.js': "export const KEY = 'tab'\n",
      'registry/index.js': "export * from './constants.js'\n",
    }),
  })
  expect(target.data?.entrypoints.map((entry) => [entry.name, entry.initial.toSorted()])).toEqual([
    ['./registry', ['registry/constants.js', 'registry/index.js']],
    ['./useTabKey', ['registry/constants.js', 'useTabKey.js']],
  ])
})

test('a package with more entrypoints than the cap says how many were measured', async () => {
  const icons = Object.fromEntries(
    Array.from({ length: MAX_PACKAGE_ENTRIES + 20 }, (_, index) => [
      `icons/i${index}.js`,
      `export const i${index} = ${index}\n`,
    ]),
  )
  const target = await analyzePackage({
    name: '@acme/icons',
    version: '1.0.0',
    files: files({
      'package.json': JSON.stringify({
        name: '@acme/icons',
        version: '1.0.0',
        exports: { './*': './icons/*.js' },
      }),
      ...icons,
    }),
  })
  expect(target.data?.entrypoints).toHaveLength(MAX_PACKAGE_ENTRIES)
  expect(target.package?.entrypointsFound).toBe(MAX_PACKAGE_ENTRIES + 20)
  const report = targetReport({ target })
  const overview = report.sections.find((section) => section.id === 'overview')
  const issues = overview?.blocks.flatMap((block) => (block.type === 'issues' ? block.items : []))
  expect(issues?.[0]?.title).toBe(
    `@acme/icons@1.0.0: measured ${MAX_PACKAGE_ENTRIES} of ${MAX_PACKAGE_ENTRIES + 20} entrypoints`,
  )
  expect(report.metrics.find((metric) => metric.id === 'entrypoints')?.hint).toContain('of 120')

  const small = await analyzePackage({
    name: '@acme/one',
    version: '1.0.0',
    files: files({ 'package.json': '{"main":"index.js"}', 'index.js': 'export {}\n' }),
  })
  expect(small.package?.entrypointsFound).toBeUndefined()
})
