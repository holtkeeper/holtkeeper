import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import {
  type BundleData,
  analyzeBundle,
  bundleAnalysis,
  bundleDataSchema,
  compareBundles,
  viteManifestResolver,
} from '../src/index.ts'

let dir: string

async function write(path: string, content: string) {
  await mkdir(dirname(join(dir, path)), { recursive: true })
  await writeFile(join(dir, path), content)
}

const lib = `
export function small() { return 'small' }
export function big() {
  return ${JSON.stringify(Array.from({ length: 400 }, (_, i) => `word${i * 7919}`).join(' '))}.split(' ')
}
`

async function writeApp(useBig: boolean) {
  await write(
    'node_modules/fake-lib/package.json',
    JSON.stringify({ name: 'fake-lib', version: '1.2.3', type: 'module' }),
  )
  await write('node_modules/fake-lib/index.js', lib)
  await write(
    'src/shared.ts',
    `import { small${useBig ? ', big' : ''} } from 'fake-lib'\nexport const shared = () => [small()${useBig ? ', ...big()' : ''}].join(',')\n`,
  )
  await write(
    'src/index.ts',
    `import { shared } from './shared.ts'\nconsole.log('index', shared())\nimport('./lazy.ts').then((m) => m.go())\n`,
  )
  await write(
    'src/admin.ts',
    `import { shared } from './shared.ts'\nconsole.log('admin page', shared())\n`,
  )
  await write('src/lazy.ts', `export const go = () => console.log('lazy loaded')\n`)
}

/** A fake build command that runs `Bun.build` and writes HTML pages pointing at its entries. */
const { runner, calls } = createFakeRunner(async (_command, { cwd }) => {
  const outdir = join(cwd, 'dist')
  await rm(outdir, { recursive: true, force: true })
  const result = await Bun.build({
    entrypoints: [join(cwd, 'src/index.ts'), join(cwd, 'src/admin.ts')],
    splitting: true,
    sourcemap: 'linked',
    minify: true,
    outdir,
    naming: { entry: '[name]-[hash].[ext]', chunk: 'chunk-[hash].[ext]' },
  })
  if (!result.success)
    return { exitCode: 1, stderr: result.logs.map((log) => log.message).join('\n') }
  const entry = (name: string) =>
    basename(
      result.outputs.find(
        (output) => output.kind === 'entry-point' && basename(output.path).startsWith(`${name}-`),
      )?.path ?? '',
    )
  await writeFile(join(outdir, 'styles.css'), 'body{margin:0;font-family:system-ui}')
  await writeFile(
    join(outdir, 'index.html'),
    `<!doctype html><link rel="stylesheet" href="/styles.css"><script type="module" src="/${entry('index')}"></script>`,
  )
  await writeFile(
    join(outdir, 'admin.html'),
    `<!doctype html><script type=module src="./${entry('admin')}"></script>`,
  )
  return { exitCode: 0 }
})

const analyze = () =>
  analyzeBundle({ dist: 'dist', build: { dir, command: ['bun', 'run', 'build'], runner } })
const record = (data: BundleData, ref: string) => ({
  id: ref,
  repo: { forge: 'test', path: 'web/app' },
  kind: 'bundle',
  ref,
  createdAt: '2026-10-30T00:00:00.000Z',
  data,
})

let before: BundleData
let after: BundleData

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holtkeeper-bundles-'))
  await writeApp(false)
  before = await analyze()
  await writeApp(true)
  after = await analyze()
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('analyzeBundle', () => {
  test('runs the build command in the project', () => {
    expect(calls[0]?.command).toEqual(['bun', 'run', 'build'])
    expect(calls[0]?.options.cwd).toBe(dir)
    expect(before.build?.command).toEqual(['bun', 'run', 'build'])
  })

  test('finds one entrypoint per HTML page with initial and lazy assets', () => {
    expect(before.entrypoints.map((entry) => entry.name)).toEqual(['admin', 'index'])
    const [admin, index] = before.entrypoints
    const names = (files: string[] = []) =>
      files.map((file) => before.assets.find((asset) => asset.file === file)?.name ?? '').toSorted()

    expect(names(index?.initial)).toEqual([
      'chunk.js [fake-lib]',
      'index.html',
      'index.js',
      'styles.css',
    ])
    expect(names(index?.lazy)).toEqual(['chunk.js [src/lazy.ts]'])
    expect(names(admin?.initial)).toEqual(['admin.html', 'admin.js', 'chunk.js [fake-lib]'])
    expect(admin?.lazy).toEqual([])
    expect(index?.initialSize.gzip).toBeGreaterThan(0)
    expect(index?.initialSize.raw).toBeGreaterThan(index?.initialSize.gzip ?? 0)
  })

  test('measures every shipped file and skips source maps', () => {
    expect(before.assets.some((asset) => asset.file.endsWith('.map'))).toBe(false)
    const css = before.assets.find((asset) => asset.name === 'styles.css')
    expect(css).toMatchObject({ kind: 'css', mapped: 0 })
    for (const asset of before.assets) {
      expect(asset.gzip).toBeGreaterThan(0)
      expect(asset.brotli).toBeGreaterThan(0)
    }
  })

  test('attributes bytes to packages and app modules through source maps', () => {
    const fakeLib = before.packages.find((pkg) => pkg.name === 'fake-lib')
    expect(fakeLib).toMatchObject({
      versions: ['1.2.3'],
      instances: ['node_modules/fake-lib'],
      entrypoints: ['admin', 'index'],
    })
    expect(before.modules.map((module) => module.name)).toEqual(
      expect.arrayContaining(['src/admin.ts', 'src/index.ts', 'src/lazy.ts', 'src/shared.ts']),
    )
    const index = before.entrypoints.find((entry) => entry.name === 'index')
    expect(index?.packages.map((pkg) => pkg.name)).toEqual(
      expect.arrayContaining(['(app)', 'fake-lib']),
    )

    const js = before.assets.filter((asset) => asset.kind === 'js')
    const attributed =
      before.packages.reduce((sum, pkg) => sum + pkg.bytes, 0) +
      before.modules.reduce((sum, module) => sum + module.bytes, 0)
    const code = before.assets
      .filter((asset) => asset.kind === 'js' || asset.kind === 'css')
      .reduce((sum, asset) => sum + asset.raw, 0)
    expect(attributed + before.unmapped).toBe(code)
    expect(js.every((asset) => asset.mapped > 0)).toBe(true)
  })

  test('produces data that passes the schema', () => {
    expect(bundleDataSchema.parse(before)).toEqual(before)
  })
})

describe('compareBundles', () => {
  test('reports growth by entrypoint, asset and package', () => {
    const comparison = compareBundles(before, after)
    const fakeLib = comparison.packages.find((pkg) => pkg.name === 'fake-lib')
    expect(fakeLib?.status).toBe('grown')
    expect(fakeLib?.delta.bytes).toBeGreaterThan(1000)

    for (const name of ['index', 'admin']) {
      const entry = comparison.entrypoints.find((item) => item.name === name)
      expect(entry?.status).toBe('changed')
      expect(entry?.delta.gzip).toBeGreaterThan(0)
    }
    const chunk = comparison.assets.find((asset) => asset.name === 'chunk.js [fake-lib]')
    expect(chunk?.status).toBe('changed')
    expect(chunk?.previousFile).not.toBe(chunk?.currentFile)
    expect(comparison.assets.find((asset) => asset.name === 'chunk.js [src/lazy.ts]')?.status).toBe(
      'unchanged',
    )
    expect(comparison.totals.js.delta.raw).toBeGreaterThan(0)
  })

  test('marks assets and packages that appear or disappear', () => {
    const trimmed: BundleData = {
      ...before,
      assets: before.assets.filter((asset) => asset.name !== 'chunk.js [src/lazy.ts]'),
      packages: [],
    }
    const comparison = compareBundles(trimmed, before)
    expect(comparison.assets.find((asset) => asset.name === 'chunk.js [src/lazy.ts]')?.status).toBe(
      'added',
    )
    expect(comparison.packages.find((pkg) => pkg.name === 'fake-lib')?.status).toBe('added')
    expect(
      compareBundles(before, trimmed).assets.find(
        (asset) => asset.name === 'chunk.js [src/lazy.ts]',
      )?.status,
    ).toBe('removed')
  })
})

describe('bundleAnalysis', () => {
  test('summarizes sizes without a previous record', () => {
    const metrics = bundleAnalysis.summarize(before)
    expect(metrics.map((metric) => metric.id)).toEqual([
      'js-gzip',
      'css-gzip',
      'initial-gzip',
      'entrypoints',
      'packages',
    ])
    expect(metrics.every((metric) => metric.delta === undefined)).toBe(true)
    expect(metrics.find((metric) => metric.id === 'packages')?.value).toBe(1)
  })

  test('reports deltas against the previous release', () => {
    const report = bundleAnalysis.toReport(record(after, 'v2'), record(before, 'v1'))
    expect(report.subject).toMatchObject({ ref: 'v2', compareTo: 'v1' })
    expect(report.sections.map((section) => section.id)).toEqual([
      'overview',
      'entrypoints',
      'composition',
      'packages',
      'assets',
    ])

    const initial = report.metrics.find((metric) => metric.id === 'initial-gzip')
    expect(initial).toMatchObject({ better: 'down', hint: 'Entrypoint index' })
    expect(initial?.delta).toBeGreaterThan(0)
    expect(report.metrics.find((metric) => metric.id === 'js-gzip')?.delta).toBeGreaterThan(0)

    const overview = report.sections[0]
    const chart = overview?.blocks.find((block) => block.type === 'chart')
    expect(chart?.type === 'chart' && chart.series.map((series) => series.key)).toEqual([
      'previous',
      'current',
    ])
    const issues = overview?.blocks.find((block) => block.type === 'issues')
    expect(issues?.type === 'issues' && issues.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(['entrypoint:index', 'entrypoint:admin']),
    )

    const packages = report.sections.find((section) => section.id === 'packages')?.blocks[0]
    const row =
      packages?.type === 'table'
        ? packages.rows.find((item) => item.name === 'fake-lib')
        : undefined
    expect(row?.delta).toBeGreaterThan(0)

    const composition = report.sections.find((section) => section.id === 'composition')?.blocks[0]
    const tree = composition?.type === 'treemap' ? composition.root : undefined
    expect(tree?.children?.map((node) => node.name)).toEqual(['admin', 'index'])
    expect(tree?.children?.[1]?.children?.map((node) => node.name)).toEqual(
      expect.arrayContaining(['fake-lib', '(app)']),
    )
  })

  test('validates uploads with its schema', () => {
    expect(bundleAnalysis.schema.safeParse({ assets: [] }).success).toBe(false)
    expect(bundleAnalysis.schema.safeParse(after).success).toBe(true)
  })
})

describe('viteManifestResolver', () => {
  test('collects entry chunks, CSS, static imports and lazy dynamic imports', async () => {
    const dist = join(dir, 'vite-dist')
    const files = [
      'index.html',
      'assets/main-B3x9kQz1.js',
      'assets/main-Ab12Cd34.css',
      'assets/vendor-Zz9yXx8w.js',
      'assets/page-Qq1wEe2r.js',
    ]
    for (const file of files) {
      await mkdir(dirname(join(dist, file)), { recursive: true })
      await writeFile(join(dist, file), '')
    }
    await mkdir(join(dist, '.vite'), { recursive: true })
    await writeFile(
      join(dist, '.vite/manifest.json'),
      JSON.stringify({
        'index.html': {
          file: 'assets/main-B3x9kQz1.js',
          src: 'index.html',
          isEntry: true,
          imports: ['_vendor'],
          dynamicImports: ['src/page.ts'],
          css: ['assets/main-Ab12Cd34.css'],
        },
        _vendor: { file: 'assets/vendor-Zz9yXx8w.js' },
        'src/page.ts': {
          file: 'assets/page-Qq1wEe2r.js',
          isDynamicEntry: true,
          imports: ['_vendor'],
        },
      }),
    )
    const entrypoints = await viteManifestResolver().resolve(dist)
    expect(entrypoints).toEqual([
      {
        name: 'index',
        initial: [
          'index.html',
          'assets/main-B3x9kQz1.js',
          'assets/main-Ab12Cd34.css',
          'assets/vendor-Zz9yXx8w.js',
        ],
        lazy: ['assets/page-Qq1wEe2r.js'],
      },
    ])
  })
})
