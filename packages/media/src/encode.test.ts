import { expect, test } from 'bun:test'

import sharp from 'sharp'

import { encodeVariants, variantCacheKey } from './encode.ts'
import { planVariants } from './plan.ts'
import { countColors, probeImage } from './probe.ts'
import { ssim } from './ssim.ts'
import type { VariantCache } from './types.ts'

/** A photo-like image: smooth color gradients plus seeded noise. */
async function photo(width: number, height: number, alpha = false): Promise<Uint8Array> {
  const channels = alpha ? 4 : 3
  const pixels = new Uint8Array(width * height * channels)
  let seed = 7
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels
      const noise = (random() - 0.5) * 24
      pixels[offset] = Math.max(0, Math.min(255, (x / width) * 255 + noise))
      pixels[offset + 1] = Math.max(0, Math.min(255, (y / height) * 200 + 30 + noise))
      pixels[offset + 2] = Math.max(0, Math.min(255, 128 + Math.sin(x / 17) * 60 + noise))
      if (alpha) {
        const dx = x - width / 2
        const dy = y - height / 2
        pixels[offset + 3] = Math.hypot(dx, dy) < Math.min(width, height) / 3 ? 255 : 0
      }
    }
  }
  return new Uint8Array(await sharp(pixels, { raw: { width, height, channels } }).png().toBuffer())
}

const alphaOf = async (data: Uint8Array) =>
  new Uint8Array(await sharp(data).extractChannel(3).raw().toBuffer())
const raw = async (data: Uint8Array) =>
  new Uint8Array(await sharp(data).ensureAlpha().raw().toBuffer())

test('AVIF and WebP of a photo-like image are much smaller than PNG and JPEG', async () => {
  const input = await photo(640, 400)
  const info = await probeImage(input)
  expect(info).toMatchObject({
    format: 'png',
    width: 640,
    height: 400,
    alpha: false,
    animated: false,
    content: 'photo',
  })
  const plan = planVariants(info, { widths: [320, 640], formats: ['avif', 'webp', 'png', 'jpeg'] })
  const { variants, failures } = await encodeVariants(input, plan.specs, { info })
  expect(failures).toEqual([])
  const size = (id: string) => variants.find((variant) => variant.spec.id === id)?.bytes ?? 0
  expect(size('avif-640w')).toBeLessThan(size('jpeg-640w'))
  expect(size('webp-640w')).toBeLessThan(size('png-640w'))
  expect(size('avif-640w')).toBeLessThan(input.byteLength / 4)
  expect(size('webp-640w')).toBeLessThan(input.byteLength / 2)
  const small = variants.find((variant) => variant.spec.id === 'avif-320w')
  expect(small).toMatchObject({ width: 320, height: 200, format: 'avif' })
  expect(small?.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(small?.data.byteLength).toBe(small?.bytes ?? -1)
  expect((await sharp(small?.data).metadata()).format).toBe('heif')
})

test('alpha survives AVIF and WebP with exact alpha edges', async () => {
  const input = await photo(300, 300, true)
  const info = await probeImage(input)
  expect(info.alpha).toBe(true)
  const plan = planVariants(info, { widths: [300] })
  expect(plan.skipped).toEqual([])
  const { variants } = await encodeVariants(input, plan.specs, { info })
  for (const variant of variants) {
    const meta = await sharp(variant.data).metadata()
    expect(meta.hasAlpha).toBe(true)
  }
  const webp = variants.find((variant) => variant.format === 'webp')
  const before = await alphaOf(input)
  const after = await alphaOf(webp?.data ?? new Uint8Array())
  expect(after).toEqual(before)
})

test('EXIF orientation is applied and metadata stripped', async () => {
  const input = new Uint8Array(
    await sharp({ create: { width: 200, height: 100, channels: 3, background: '#808080' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer(),
  )
  const info = await probeImage(input)
  expect([info.width, info.height]).toEqual([100, 200])
  const { variants } = await encodeVariants(
    input,
    planVariants(info, { formats: ['jpeg'] }).specs,
    { info },
  )
  const meta = await sharp(variants[0]?.data).metadata()
  expect([meta.width, meta.height]).toEqual([100, 200])
  expect(meta.exif).toBeUndefined()
  expect(meta.orientation).toBeUndefined()
})

test('SSIM search lowers quality while staying above the target', async () => {
  const input = await photo(256, 256)
  const info = await probeImage(input)
  const [spec] = planVariants(info, { formats: ['webp'], targetSsim: 0.85 }).specs
  if (!spec) throw new Error('no spec')
  const { variants } = await encodeVariants(input, [spec], { info })
  const variant = variants[0]
  expect(variant?.quality).toBeLessThan(spec.quality)
  expect(variant?.quality).toBeGreaterThanOrEqual(spec.minQuality ?? 0)
  expect(variant?.ssim).toBeGreaterThanOrEqual(0.85)
})

test('animated GIF is re-encoded as animated WebP with every frame', async () => {
  const frames = 3
  const strip = await sharp({
    create: { width: 40, height: 40 * frames, channels: 4, background: '#ff0000' },
  })
    .composite([
      {
        input: { create: { width: 40, height: 40, channels: 4, background: '#00ff00' } },
        top: 40,
        left: 0,
      },
      {
        input: { create: { width: 40, height: 40, channels: 4, background: '#0000ff' } },
        top: 80,
        left: 0,
      },
    ])
    .raw()
    .toBuffer()
  const gif = new Uint8Array(
    await sharp(strip, { raw: { width: 40, height: 40 * frames, channels: 4, pageHeight: 40 } })
      .gif({ loop: 0, delay: [100, 100, 100] })
      .toBuffer(),
  )
  const info = await probeImage(gif)
  expect(info).toMatchObject({ animated: true, frames: 3, width: 40, height: 40 })
  const plan = planVariants(info)
  expect(plan.skipped.map((entry) => entry.format)).toEqual(['avif'])
  const { variants, failures } = await encodeVariants(gif, plan.specs, { info })
  expect(failures).toEqual([])
  const webp = variants.find((variant) => variant.format === 'webp')
  expect((await sharp(webp?.data, { animated: true }).metadata()).pages).toBe(3)
  expect(webp).toMatchObject({ width: 40, height: 40 })
})

test('flat graphics are detected and palette PNG stays lossless', async () => {
  const input = new Uint8Array(
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#123456' } })
      .composite([
        {
          input: { create: { width: 32, height: 32, channels: 4, background: '#ffcc00' } },
          top: 0,
          left: 0,
        },
      ])
      .png({ compressionLevel: 0 })
      .toBuffer(),
  )
  const info = await probeImage(input)
  expect(info).toMatchObject({ content: 'graphic', colors: 2 })
  const { variants } = await encodeVariants(input, planVariants(info, { formats: ['png'] }).specs, {
    info,
  })
  const png = variants[0]
  expect(png?.bytes).toBeLessThan(input.byteLength)
  expect(await raw(png?.data ?? new Uint8Array())).toEqual(await raw(input))
})

test('encoding failures are reported per spec and aborts throw', async () => {
  const input = await photo(64, 64)
  const info = await probeImage(input)
  const [spec] = planVariants(info, { formats: ['webp'] }).specs
  if (!spec) throw new Error('no spec')
  const { failures } = await encodeVariants(input, [{ ...spec, width: 0, height: 0 }], { info })
  expect(failures).toHaveLength(1)
  const controller = new AbortController()
  controller.abort()
  const aborted = await encodeVariants(input, [spec], { info, signal: controller.signal }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(aborted).toBeDefined()
})

test('countColors stops past the limit and ssim scores similarity', () => {
  const rgba = new Uint8Array([1, 2, 3, 255, 1, 2, 3, 255, 9, 9, 9, 255])
  expect(countColors(rgba, 10)).toBe(2)
  expect(countColors(rgba, 1)).toBe(2)
  const a = Uint8Array.from({ length: 256 }, (_, index) => index)
  expect(ssim(a, a, 16, 16)).toBeCloseTo(1, 6)
  const noisy = a.map((value, index) => (index % 2 ? 255 - value : value))
  expect(ssim(a, noisy, 16, 16)).toBeLessThan(0.5)
})

const mapCache = () => {
  const entries = new Map<
    string,
    { data: Uint8Array; meta: Record<string, string | number | boolean> }
  >()
  const cache: VariantCache = {
    get: async (key) => entries.get(key),
    set: async (key, data, entry) => {
      entries.set(key, { data, meta: entry?.meta ?? {} })
    },
  }
  return { entries, cache }
}

test('reuses cached variants of the same bytes and spec', async () => {
  const input = await photo(320, 200)
  const info = await probeImage(input)
  const plan = planVariants(info, { widths: [160], formats: ['avif', 'webp'] })
  const { entries, cache } = mapCache()
  const first = await encodeVariants(input, plan.specs, { info, cache })
  expect(first.cached).toBe(0)
  expect(entries.size).toBe(plan.specs.length)
  const second = await encodeVariants(input, plan.specs, { info, cache })
  expect(second.cached).toBe(plan.specs.length)
  expect(second.variants.map((variant) => variant.sha256)).toEqual(
    first.variants.map((variant) => variant.sha256),
  )
  expect(second.variants[0]).toMatchObject({
    width: first.variants[0]?.width,
    quality: first.variants[0]?.quality,
  })

  const lower = planVariants(info, { widths: [160], formats: ['avif'], quality: { avif: 40 } })
  expect((await encodeVariants(input, lower.specs, { info, cache })).cached).toBe(0)
})

test('cache keys change with the spec and encoder versions, not the spec id', () => {
  const spec = {
    id: 'avif-640w',
    format: 'avif',
    width: 640,
    height: 400,
    quality: 55,
    effort: 4,
  } as const
  const key = variantCacheKey('a'.repeat(64), spec, { sharp: '0.35.5', vips: '8.18.7' })
  expect(key).toMatch(/^media\/v1\/a{64}\/[0-9a-f]{64}$/)
  expect(
    variantCacheKey('a'.repeat(64), { ...spec, id: 'other' }, { sharp: '0.35.5', vips: '8.18.7' }),
  ).toBe(key)
  expect(
    variantCacheKey('a'.repeat(64), { ...spec, quality: 50 }, { sharp: '0.35.5', vips: '8.18.7' }),
  ).not.toBe(key)
  expect(variantCacheKey('a'.repeat(64), spec, { sharp: '0.36.0', vips: '8.18.7' })).not.toBe(key)
})
