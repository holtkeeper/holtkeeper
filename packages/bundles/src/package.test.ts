import { expect, test } from 'bun:test'

import { analyzePackage, packageEntries } from './package.ts'

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
