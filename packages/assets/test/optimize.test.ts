import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import { type Edit, requireSharp } from '@holtkeeper/media'

import {
  analyzeAssets,
  assetsAnalysis,
  assetsAnalyzer,
  assetsDataSchema,
  collectArtifacts,
} from '../src/index.ts'

let dir = ''

const put = async (path: string, content: string | Uint8Array) => {
  await mkdir(dirname(join(dir, path)), { recursive: true })
  await writeFile(join(dir, path), content)
}

async function photo(width: number, height: number): Promise<Uint8Array> {
  const sharp = await requireSharp()
  const pixels = new Uint8Array(width * height * 3)
  let seed = 3
  for (let index = 0; index < pixels.length; index += 3) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    const noise = (seed / 2_147_483_648 - 0.5) * 20
    const x = (index / 3) % width
    const y = Math.floor(index / 3 / width)
    pixels[index] = Math.max(0, Math.min(255, (x / width) * 255 + noise))
    pixels[index + 1] = Math.max(0, Math.min(255, (y / height) * 255 + noise))
    pixels[index + 2] = Math.max(0, Math.min(255, 140 + noise))
  }
  return new Uint8Array(
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
  )
}

const icon = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.5.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 24 24" style="enable-background:new 0 0 24 24;" xml:space="preserve">
<style type="text/css">
	.st0{fill:#FF6600;}
</style>
<path id="ring" class="st0" d="M12.000000,2.250000c-5.384776,0-9.750000,4.365224-9.750000,9.750000s4.365224,9.750000,9.750000,9.750000
	s9.750000-4.365224,9.750000-9.750000S17.384776,2.250000,12.000000,2.250000z M12.000000,20.250000c-4.556349,0-8.250000-3.693651-8.250000-8.250000
	s3.693651-8.250000,8.250000-8.250000s8.250000,3.693651,8.250000,8.250000S16.556349,20.250000,12.000000,20.250000z"/>
<path class="st0" d="M10.500000,15.750000l-3.750000-3.750000l1.060660-1.060660l2.689340,2.689340l5.689340-5.689340l1.060660,1.060660L10.500000,15.750000z"/>
</svg>
`

const app = [
  "import styles from './App.module.css'",
  '',
  'export function App() {',
  '  return (',
  '    <main>',
  '      <img src="/hero.png" alt="Mountains" className={styles.hero} />',
  '      <img src="/badge.png" alt="" width={120} height={120} />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

const css = '.banner {\n  background-image: url(/hero.png);\n}\n'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assets-optimize-'))
  await put('package.json', JSON.stringify({ name: 'site', dependencies: { react: '^19.0.0' } }))
  await put('src/App.tsx', app)
  await put('src/styles.css', css)
  await put('public/hero.png', await photo(1400, 700))
  await put('public/badge.png', await photo(400, 400))
  await put('public/icons/ring.svg', icon)
  await put(
    'public/broken.png',
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(9000)]),
  )
})

afterAll(() => rm(dir, { recursive: true, force: true }))

const sliceRange = (text: string, edit: Extract<Edit, { kind: 'replace' }>) => {
  const lines = text.split('\n')
  const offset = (line: number, column: number) =>
    lines.slice(0, line - 1).reduce((total, entry) => total + entry.length + 1, 0) + column - 1
  return text.slice(
    offset(edit.range.start.line, edit.range.start.column),
    offset(edit.range.end.line, edit.range.end.column),
  )
}

test('sharp measures real variants, proposes changes and keeps data JSON-safe', async () => {
  const data = await analyzeAssets({ dir, convert: 'sharp', minBytes: 1024 })
  expect(data.convert).toBe('sharp')
  expect(data.tools).toEqual(['sharp', 'svgo'])
  expect(assetsDataSchema.parse(data)).toEqual(data)
  expect(JSON.parse(JSON.stringify(data))).toEqual(data)
  expect(JSON.stringify(data)).not.toContain('"data":')

  const hero = data.optimized?.find((image) => image.path === 'public/hero.png')
  expect(hero).toMatchObject({ width: 1400, height: 700, usage: 'responsive' })
  const heroAvif = hero?.variants.filter((variant) => variant.format === 'avif') ?? []
  expect(heroAvif.map((variant) => variant.width)).toEqual([320, 640, 960, 1280, 1400])
  expect(heroAvif.map((variant) => variant.file)).toContain('public/hero-640w.avif')
  expect(hero?.best?.format).toBe('avif')
  expect(hero?.best?.savingPercent).toBeGreaterThan(50)
  expect(hero?.references).toEqual([
    { file: 'src/App.tsx', line: 6, kind: 'img' },
    { file: 'src/styles.css', line: 2, kind: 'css' },
  ])

  const badge = data.optimized?.find((image) => image.path === 'public/badge.png')
  expect(badge?.usage).toBe('fixed')
  expect(
    badge?.variants.filter((variant) => variant.format === 'webp').map((variant) => variant.file),
  ).toEqual(['public/badge@1x.webp', 'public/badge@2x.webp', 'public/badge@3x.webp'])
  expect(data.optimized?.find((image) => image.path === 'public/broken.png')?.error).toMatch(
    /^cannot decode/,
  )

  const heroChange = data.changes?.find((change) => change.id === 'assets:image:public/hero.png')
  expect(heroChange?.confidence).toBe('review')
  const binaries = heroChange?.edits.filter((edit) => edit.kind === 'write-binary') ?? []
  expect(binaries.length).toBeGreaterThan(5)
  const artifacts = new Map(collectArtifacts(data).map((artifact) => [artifact.sha256, artifact]))
  for (const edit of binaries) {
    if (edit.kind !== 'write-binary') continue
    expect(edit.base64).toBeUndefined()
    const artifact = artifacts.get(edit.artifact ?? '')
    expect(artifact?.bytes).toBe(edit.bytes)
    expect(
      createHash('sha256')
        .update(artifact?.data ?? new Uint8Array())
        .digest('hex'),
    ).toBe(edit.artifact ?? '')
  }
  const replacesOriginal = binaries.find((edit) => edit.file === 'public/hero.png')
  if (replacesOriginal?.kind === 'write-binary') {
    const original = await readFile(join(dir, 'public/hero.png'))
    expect(replacesOriginal.previousSha256).toBe(
      createHash('sha256').update(original).digest('hex'),
    )
  }

  const swaps = heroChange?.edits.filter((edit) => edit.kind === 'replace') ?? []
  const tsx = swaps.find((edit) => edit.file === 'src/App.tsx')
  if (tsx?.kind !== 'replace') throw new Error('no TSX swap')
  expect(tsx.oldText).toBe('<img src="/hero.png" alt="Mountains" className={styles.hero} />')
  expect(sliceRange(app, tsx)).toBe(tsx.oldText)
  expect(tsx.newText.split('\n')[0]).toBe('<picture>')
  expect(tsx.newText).toContain(
    '      <source type="image/avif" srcSet="/hero-320w.avif 320w, /hero-640w.avif 640w',
  )
  expect(tsx.newText).toContain(
    'alt="Mountains" className={styles.hero} loading="lazy" decoding="async" />',
  )
  expect(tsx.newText).toContain('width={1400} height={700}')
  expect(tsx.newText.endsWith('      </picture>')).toBe(true)
  const cssEdit = swaps.find((edit) => edit.file === 'src/styles.css')
  if (cssEdit?.kind !== 'replace') throw new Error('no CSS swap')
  expect(sliceRange(css, cssEdit)).toBe(cssEdit.oldText)
  expect(cssEdit.newText).toStartWith(
    'background-image: url(/hero.png);\n  background-image: image-set(url("/hero-1400w.avif") type("image/avif")',
  )

  const badgeChange = data.changes?.find((change) => change.id === 'assets:image:public/badge.png')
  const badgeSwap = badgeChange?.edits.find((edit) => edit.kind === 'replace')
  expect(badgeSwap?.kind === 'replace' && badgeSwap.newText).toContain(
    'srcSet="/badge@1x.webp 1x, /badge@2x.webp 2x, /badge@3x.webp 3x"',
  )

  const svg = data.svgs?.find((entry) => entry.path === 'public/icons/ring.svg')
  expect(svg?.preset).toBe('safe')
  expect(svg?.bytes.after).toBeLessThan(svg?.bytes.before ?? 0)
  expect(svg?.breakdown.paths.before.digits).toBeGreaterThan(
    svg?.breakdown.paths.after.digits ?? Infinity,
  )
  const svgChange = data.changes?.find((change) => change.id === 'assets:svg:public/icons/ring.svg')
  expect(svgChange?.confidence).toBe('safe')
  const svgEdit = svgChange?.edits[0]
  expect(svgEdit?.kind === 'replace' && svgEdit.oldText).toBe(icon)
  expect(svgEdit?.kind === 'replace' && svgEdit.newText).toContain('id="ring"')
  expect(svgEdit?.kind === 'replace' && svgEdit.newText).toContain('viewBox="0 0 24 24"')

  const suggestion = data.suggestions.find((entry) => entry.path === 'public/hero.png')
  expect(suggestion).toMatchObject({ method: 'measured', suggested: 'avif' })
  expect(data.suggestions.find((entry) => entry.path === 'public/icons/ring.svg')).toMatchObject({
    rule: 'svg',
    method: 'measured',
  })

  const record = (value: typeof data, id: string) => ({
    id,
    repo: { forge: 'gitlab', path: 'web/site' },
    kind: 'assets',
    createdAt: '2026-10-30T00:00:00.000Z',
    data: value,
  })
  const report = assetsAnalysis.toReport(record(data, '2'), record(data, '1'))
  expect(report.sections.map((section) => section.id)).toEqual([
    'overview',
    'budgets',
    'suggestions',
    'optimization',
    'svg',
    'largest',
    'changes',
    'duplicates',
  ])
  const optimization = report.sections.find((section) => section.id === 'optimization')
  const summary = optimization?.blocks[0]
  expect(
    summary?.type === 'table' && summary.rows.find((row) => row.path === 'public/hero.png'),
  ).toMatchObject({
    delta: 0,
    usages: 2,
  })
  const card = optimization?.blocks.find(
    (block) => block.type === 'table' && block.title?.startsWith('public/hero.png'),
  )
  expect(card?.type === 'table' && card.rows.map((row) => row.format)).toEqual([
    'original png',
    'AVIF',
    'WebP',
    'PNG',
  ])
  const changesBlock = optimization?.blocks.find((block) => block.type === 'changes')
  expect(changesBlock?.type === 'changes' && changesBlock.applicable).toBe(true)
  const heroItem =
    changesBlock?.type === 'changes'
      ? changesBlock.items.find((item) => item.change.id === heroChange?.id)
      : undefined
  expect(heroItem?.diff.find((diff) => diff.file === 'public/hero-640w.avif')).toEqual({
    file: 'public/hero-640w.avif',
    status: 'added',
    hunks: [],
  })
  expect(heroItem?.diff.find((diff) => diff.file === 'src/App.tsx')?.hunks.length).toBeGreaterThan(
    0,
  )
  expect(optimization?.blocks.some((block) => block.type === 'issues')).toBe(true)
  const svgSection = report.sections.find((section) => section.id === 'svg')
  expect(svgSection?.blocks.map((block) => block.type)).toEqual(['table', 'table', 'changes'])
  expect(assetsAnalysis.changes?.(data)).toHaveLength(data.changes?.length ?? -1)
  expect(report.metrics.find((metric) => metric.id === 'changes')).toMatchObject({
    value: 3,
    delta: 0,
  })

  const parsed = assetsDataSchema.parse(JSON.parse(JSON.stringify(data)))
  expect(collectArtifacts(parsed)).toEqual([])
})

test('optimizeTop limits the measured images and convert defaults to sharp', async () => {
  const data = await analyzeAssets({ dir, minBytes: 1024, optimizeTop: 1 })
  expect(data.convert).toBe('sharp')
  expect(data.optimized?.map((image) => image.path)).toEqual(['public/hero.png'])
  expect(data.svgs).toEqual([])
})

test('the analyzer returns the encoded variants as run artifacts', async () => {
  const { runner } = createFakeRunner()
  const options = assetsAnalyzer.options.parse({ convert: 'sharp', optimizeTop: 1 })
  const { data, artifacts } = await assetsAnalyzer.run({
    repo: { forge: 'gitlab', path: 'web/site' },
    dir,
    runner,
    options,
  })
  const variants = data.optimized?.[0]?.variants.filter((variant) => variant.proposed) ?? []
  expect(artifacts?.length).toBe(new Set(variants.map((variant) => variant.sha256)).size)
  const first = artifacts?.find((artifact) => artifact.id === variants[0]?.sha256)
  expect(first).toMatchObject({ contentType: 'image/avif', name: variants[0]?.file })
  expect(
    createHash('sha256')
      .update(first?.data ?? new Uint8Array())
      .digest('hex'),
  ).toBe(first?.id ?? '')
})
