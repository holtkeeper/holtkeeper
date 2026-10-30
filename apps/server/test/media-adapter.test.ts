import { expect, test } from 'bun:test'

import { outputFormats, requireSharp } from '@holtkeeper/media'

import { mediaEngine, planOptionsOf } from '../src/media/adapter.ts'

const png = async (width: number, height: number) => {
  const sharp = await requireSharp()
  return new Uint8Array(
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: '#3366aa',
        noise: { type: 'gaussian', mean: 120, sigma: 25 },
      },
    })
      .png()
      .toBuffer(),
  )
}

test('request options map to plan options', () => {
  expect(
    planOptionsOf(
      { formats: ['webp', 'jpg', 'bmp'], widths: [320], quality: 60, preset: 'fast' },
      outputFormats,
    ),
  ).toEqual({ formats: ['webp', 'jpeg'], widths: [320], quality: 60, effort: 'fast' })
  expect(planOptionsOf({ densities: [1, 2], preset: 'hero' }, outputFormats)).toEqual({
    usage: 'texture',
    densities: [1, 2],
  })
})

test('variants come from sharp with suggested paths next to the original', async () => {
  const engine = mediaEngine()
  const data = await png(800, 400)
  const result = await engine.variants({
    data,
    file: 'img/hero.png',
    options: { formats: ['avif', 'webp'], widths: [400, 800] },
    maxPixels: 10_000_000,
  })
  expect(result.original).toEqual({
    width: 800,
    height: 400,
    format: 'png',
    bytes: data.byteLength,
  })
  expect(result.variants.map((variant) => [variant.path, variant.contentType])).toEqual([
    ['img/hero-400w.avif', 'image/avif'],
    ['img/hero-800w.avif', 'image/avif'],
    ['img/hero-400w.webp', 'image/webp'],
    ['img/hero-800w.webp', 'image/webp'],
  ])
  expect(result.variants.every((variant) => variant.data.byteLength < data.byteLength)).toBe(true)
  const refused = await engine
    .variants({ data, file: 'img/hero.png', options: {}, maxPixels: 1000 })
    .then(
      () => undefined,
      (error: unknown) => String(error),
    )
  expect(refused).toContain('more than 1000 pixels')

  const snippets = await engine.snippets({
    file: '/img/hero.png',
    original: result.original,
    variants: result.variants.map((variant) => ({
      path: `/${variant.path}`,
      format: variant.format,
      width: variant.width,
      height: variant.height,
    })),
  })
  expect(snippets.html).toContain(
    '<source type="image/avif" srcset="/img/hero-400w.avif 400w, /img/hero-800w.avif 800w"',
  )
  expect(snippets.react).toContain('width={800} height={400}')
  expect(Object.keys(snippets)).toContain('pixi')
})

test('SVGs are optimized with the safe preset', async () => {
  const engine = mediaEngine()
  const svg =
    '<?xml version="1.0"?>\n<!-- Generator: Sketch -->\n<svg xmlns="http://www.w3.org/2000/svg" id="icon" width="24" height="24" viewBox="0 0 24 24"><path d="M1.000000 2.000000L3.123456 4.123456"/></svg>'
  const result = await engine.optimizeSvg({ svg, file: 'icon.svg' })
  expect(result.after).toBeLessThan(result.before)
  expect(result.data).toContain('id="icon"')
  expect(result).toMatchObject({ width: 24, height: 24 })
  expect(result.breakdown).toMatchObject({ comments: 1 })
  const snippets = await engine.snippets({
    file: '/icon.svg',
    original: { width: 24, height: 24, format: 'svg', bytes: result.before },
    variants: [],
  })
  expect(snippets.react).toBe(
    '<img src="/icon.svg" width={24} height={24} alt="" loading="lazy" decoding="async" />',
  )
})
