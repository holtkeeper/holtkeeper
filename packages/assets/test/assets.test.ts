import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { analyzeAssets, assetsAnalysis, assetsAnalyzer, assetsDataSchema } from '../src/index.ts'
import * as make from './fixtures.ts'

let dir = ''

const put = async (path: string, content: string | Uint8Array) => {
  await mkdir(dirname(join(dir, path)), { recursive: true })
  await writeFile(join(dir, path), content)
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assets-integration-'))
  const background = make.png(5000, 300, { padding: 40_000 })
  await put('package.json', JSON.stringify({ dependencies: { phaser: '^3.80.0' } }))
  await put(
    'src/main.ts',
    [
      "this.load.image('background', 'background.png')",
      "this.load.atlas('sheet', 'sprites/sheet.png', 'sprites/sheet.json')",
      "this.load.audio('jump', 'sfx/jump.wav')",
      "import photo from '../public/photo.jpg'",
      "const copy = 'copy.png'",
      '@font-face { src: url(fonts/title.ttf) }',
    ].join('\n'),
  )
  await put('public/background.png', background)
  await put('public/copy.png', background)
  await put('public/sprites/sheet.png', make.png(512, 512, { colorType: 6, padding: 20_000 }))
  await put(
    'public/sprites/sheet.json',
    JSON.stringify({ frames: { a: {}, b: {}, c: {} }, meta: { image: 'sheet.png' } }),
  )
  await put('public/photo.jpg', make.jpeg(1920, 1080, 30_000))
  await put('public/sfx/jump.wav', make.wav(1))
  await put('public/fonts/title.ttf', new Uint8Array([...make.ttf(120), ...new Uint8Array(20_000)]))
  await put('public/orphan.gif', make.gif(10, 10, 1))
  await put('public/robots.txt', 'User-agent: *')
  await put('src/game/assets/level.bin', new Uint8Array(300 * 1024))
  await put('src/game/assets/index.ts', 'export {}')
  await put('dist/background.png', background)
  await put('node_modules/pkg/public/ignored.png', make.png(1, 1))
})

afterAll(() => rm(dir, { recursive: true, force: true }))

test('inventories, checks budgets, suggests and reports', async () => {
  const data = await analyzeAssets({
    dir,
    dist: 'dist',
    convert: 'estimate',
    budgets: [{ pattern: 'public/**/*.png', maxBytes: 30_000, maxWidth: 4096 }],
    total: { audio: 10_000 },
  })
  expect(assetsDataSchema.parse(data)).toEqual(data)
  expect(data.engines).toEqual(['phaser'])
  expect(data.assets.map((asset) => asset.path)).toEqual([
    'dist/background.png',
    'public/background.png',
    'public/copy.png',
    'public/fonts/title.ttf',
    'public/orphan.gif',
    'public/photo.jpg',
    'public/sfx/jump.wav',
    'public/sprites/sheet.json',
    'public/sprites/sheet.png',
    'src/game/assets/level.bin',
  ])
  const byPath = new Map(data.assets.map((asset) => [asset.path, asset]))
  expect(byPath.get('public/sprites/sheet.json')).toMatchObject({
    kind: 'atlas',
    atlas: { frames: 3, images: ['sheet.png'] },
  })
  expect(byPath.get('public/sprites/sheet.json')?.gzip).toBeGreaterThan(0)
  expect(byPath.get('public/sfx/jump.wav')?.audio).toMatchObject({ durationMs: 1000, channels: 2 })
  expect(byPath.get('public/fonts/title.ttf')?.font).toEqual({ format: 'truetype', glyphs: 120 })
  expect(byPath.get('src/game/assets/level.bin')?.kind).toBe('other')
  expect(byPath.get('dist/background.png')).toMatchObject({ origin: 'build' })
  expect(byPath.get('dist/background.png')?.referenced).toBeUndefined()

  expect(data.findings.map((finding) => finding.id)).toEqual([
    'huge-dimensions:public/background.png',
    'non-power-of-two:public/background.png',
    'huge-dimensions:public/copy.png',
    'non-power-of-two:public/copy.png',
    'unused:public/orphan.gif',
    'non-power-of-two:public/photo.jpg',
    'unused:src/game/assets/level.bin',
  ])
  expect(data.budgets.map((violation) => violation.id).toSorted()).toEqual([
    'bytes:public/**/*.png:public/background.png',
    'bytes:public/**/*.png:public/copy.png',
    'total:audio',
    'width:public/**/*.png:public/background.png',
    'width:public/**/*.png:public/copy.png',
  ])
  expect(data.duplicates).toEqual([
    {
      hash: byPath.get('public/background.png')?.hash ?? '',
      bytes: byPath.get('public/background.png')?.bytes ?? 0,
      paths: ['public/background.png', 'public/copy.png'],
    },
  ])
  expect(data.suggestions.map((suggestion) => [suggestion.path, suggestion.rule])).toEqual([
    ['public/sfx/jump.wav', 'uncompressed-audio'],
    ['public/background.png', 'opaque-png'],
    ['public/copy.png', 'opaque-png'],
    ['public/photo.jpg', 'jpeg'],
    ['public/fonts/title.ttf', 'desktop-font'],
    ['public/sprites/sheet.png', 'alpha-png'],
  ])
  const imageTotal = data.totals.find((total) => total.kind === 'image')
  expect(imageTotal?.count).toBe(5)

  const record = (id: string, value: typeof data, ref: string) => ({
    id,
    repo: { forge: 'gitlab', path: 'games/app' },
    kind: 'assets',
    ref,
    createdAt: '2026-10-29T00:00:00.000Z',
    data: value,
  })
  const shrunk = {
    ...data,
    assets: data.assets.filter((asset) => asset.path !== 'public/orphan.gif'),
  }
  const report = assetsAnalysis.toReport(record('2', data, 'v2'), record('1', shrunk, 'v1'))
  expect(report.sections.map((section) => section.id)).toEqual([
    'overview',
    'budgets',
    'suggestions',
    'largest',
    'changes',
    'duplicates',
  ])
  expect(report.metrics.find((metric) => metric.id === 'over-budget')).toMatchObject({
    value: 3,
    delta: 0,
  })
  const changes = report.sections.find((section) => section.id === 'changes')
  const assetTable = changes?.blocks[1]
  expect(assetTable?.type === 'table' && assetTable.rows[0]).toMatchObject({
    path: 'public/orphan.gif',
    status: 'added',
  })
  const first = assetsAnalysis.toReport(record('1', shrunk, 'v1'))
  expect(first.sections.map((section) => section.id)).not.toContain('changes')
})

test('the analyzer validates options and passes the runner for tool measurements', async () => {
  const { runner, calls } = createFakeRunner(() => ({ exitCode: 127 }))
  const options = assetsAnalyzer.options.parse({ convert: 'tools', roots: ['public/**'] })
  const { data } = await assetsAnalyzer.run({
    repo: { forge: 'gitlab', path: 'games/app' },
    dir,
    runner,
    options,
    ref: 'v3',
  })
  expect(data.roots).toEqual(['public/**'])
  expect(data.convert).toBe('tools')
  expect(data.tools).toEqual([])
  expect(data.suggestions.every((suggestion) => suggestion.method === 'estimate')).toBe(true)
  expect(new Set(calls.map((call) => call.command[0]))).toEqual(
    new Set(['cwebp', 'avifenc', 'ffmpeg', 'woff2_compress']),
  )
})
