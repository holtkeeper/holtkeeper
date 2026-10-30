import { expect, test } from 'bun:test'

import { planVariants } from './plan.ts'
import type { ImageInfo } from './types.ts'

const photo: ImageInfo = {
  format: 'jpeg',
  width: 2000,
  height: 1000,
  alpha: false,
  animated: false,
  content: 'photo',
}

test('responsive ladder is capped at the source width and keeps the source width', () => {
  const plan = planVariants(photo)
  expect(plan.usage).toBe('responsive')
  expect(plan.skipped).toEqual([])
  const widths = (format: string) =>
    plan.specs.filter((spec) => spec.format === format).map((spec) => spec.width)
  expect(widths('avif')).toEqual([320, 640, 960, 1280, 1920, 2000])
  expect(widths('webp')).toEqual(widths('avif'))
  expect(widths('jpeg')).toEqual(widths('avif'))
  const top = plan.specs.find((spec) => spec.id === 'jpeg-2000w')
  expect(top).toMatchObject({ replacesOriginal: true, height: 1000, quality: 78 })
  expect(plan.specs.find((spec) => spec.id === 'avif-640w')).toMatchObject({
    height: 320,
    chromaSubsampling: '4:2:0',
    quality: 55,
  })
  expect(plan.specs.filter((spec) => spec.replacesOriginal)).toHaveLength(1)
})

test('sources wider than the ladder keep a full-size re-encode only in their own format', () => {
  const plan = planVariants({ ...photo, width: 4000, height: 2000 })
  expect(plan.specs.filter((spec) => spec.format === 'avif').at(-1)?.width).toBe(2560)
  expect(plan.specs.filter((spec) => spec.format === 'jpeg').map((spec) => spec.width)).toEqual([
    320, 640, 960, 1280, 1920, 2560,
  ])
})

test('fixed display size gets a density ladder that never upscales', () => {
  const plan = planVariants({ ...photo, width: 500, height: 250 }, { displayWidth: 200 })
  expect(plan.usage).toBe('fixed')
  expect(
    plan.specs.filter((spec) => spec.format === 'webp').map((spec) => [spec.id, spec.width]),
  ).toEqual([
    ['webp@1x', 200],
    ['webp@2x', 400],
    ['webp@3x', 500],
  ])
})

test('textures treat the source as the highest density and never replace it', () => {
  const plan = planVariants(
    { ...photo, format: 'png', width: 1024, height: 512, content: 'graphic', colors: 40 },
    { usage: 'texture' },
  )
  expect(plan.specs.map((spec) => spec.id)).toEqual([
    'avif@1x',
    'avif@2x',
    'webp@1x',
    'webp@2x',
    'png@1x',
    'png@2x',
  ])
  expect(plan.specs.find((spec) => spec.id === 'png@1x')).toMatchObject({
    width: 512,
    height: 256,
    palette: true,
  })
  expect(plan.specs.some((spec) => spec.replacesOriginal)).toBe(false)
  expect(plan.specs.find((spec) => spec.id === 'webp@2x')?.lossless).toBe(true)
})

test('alpha keeps edges clean and drops JPEG', () => {
  const plan = planVariants(
    { ...photo, format: 'png', alpha: true },
    { formats: ['avif', 'webp', 'jpeg', 'png'], widths: [640] },
  )
  expect(plan.skipped).toEqual([{ format: 'jpeg', reason: 'JPEG has no alpha channel' }])
  expect(plan.specs.find((spec) => spec.id === 'webp-640w')).toMatchObject({ alphaQuality: 100 })
  expect(plan.specs.find((spec) => spec.id === 'avif-640w')).toMatchObject({
    chromaSubsampling: '4:4:4',
    quality: 70,
  })
  expect(plan.specs.find((spec) => spec.id === 'png-640w')).toMatchObject({ lossless: true })
  expect(plan.specs.find((spec) => spec.id === 'png-640w')?.palette).toBeUndefined()
})

test('graphics with more than 256 colors use near-lossless WebP', () => {
  const plan = planVariants(
    { ...photo, format: 'png', content: 'graphic' },
    { widths: [640], formats: ['webp'] },
  )
  expect(plan.specs[0]).toMatchObject({ nearLossless: true, quality: 60 })
})

test('animated sources skip encoders that cannot animate and keep their size', () => {
  const plan = planVariants({
    ...photo,
    format: 'gif',
    animated: true,
    frames: 12,
    width: 400,
    height: 300,
  })
  expect(plan.skipped.map((entry) => entry.format)).toEqual(['avif'])
  expect(plan.specs.map((spec) => [spec.id, spec.animated])).toEqual([
    ['webp-400w', true],
    ['gif-400w', true],
  ])
})

test('quality options and SSIM search bounds', () => {
  const plan = planVariants(photo, {
    quality: { avif: 60 },
    targetSsim: 0.98,
    widths: [640],
    formats: ['avif', 'jpeg'],
  })
  expect(plan.specs.find((spec) => spec.format === 'avif')).toMatchObject({
    quality: 60,
    targetSsim: 0.98,
    minQuality: 30,
  })
  expect(plan.specs.find((spec) => spec.format === 'jpeg')).toMatchObject({
    quality: 78,
    minQuality: 48,
  })
  const png = planVariants(
    { ...photo, format: 'png' },
    { targetSsim: 0.98, widths: [640], formats: ['png'] },
  )
  expect(png.specs[0]?.targetSsim).toBeUndefined()
})
