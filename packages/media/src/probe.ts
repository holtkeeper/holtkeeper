import type sharpFactory from 'sharp'

import type { ImageInfo } from './types.ts'

type SharpFactory = typeof sharpFactory

let loaded: Promise<SharpFactory | undefined> | undefined

/** sharp, loaded on first use; `undefined` when its native binary is not available. */
export function loadSharp(): Promise<SharpFactory | undefined> {
  loaded ??= import('sharp').then(
    (module) => module.default,
    () => undefined,
  )
  return loaded
}

/** Whether sharp loads on this machine. */
export async function sharpAvailable(): Promise<boolean> {
  return (await loadSharp()) !== undefined
}

/** sharp, or an error saying it is missing. */
export async function requireSharp(): Promise<SharpFactory> {
  const sharp = await loadSharp()
  if (!sharp) throw new Error('sharp is not available on this machine')
  return sharp
}

/** Whether an ICC profile describes sRGB, judged by its description text. */
export function isSrgbProfile(icc: Uint8Array): boolean {
  const text = Buffer.from(icc).toString('latin1')
  return text.includes('sRGB') || text.includes('s\0R\0G\0B')
}

/**
 * Distinct RGBA colors of raw 4-channel pixels, counting up to `limit + 1` and stopping there,
 * so the answer is exact only while it is at most `limit`.
 */
export function countColors(rgba: Uint8Array, limit: number): number {
  const seen = new Set<number>()
  const view = new DataView(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  for (let offset = 0; offset + 3 < rgba.byteLength; offset += 4) {
    seen.add(view.getUint32(offset))
    if (seen.size > limit) break
  }
  return seen.size
}

const MAX_COUNTED_PIXELS = 16_000_000

/** Dimensions, alpha, animation and content type of an encoded image. Throws when sharp cannot decode it. */
export async function probeImage(input: Uint8Array): Promise<ImageInfo> {
  const sharp = await requireSharp()
  const meta = await sharp(input, { animated: true }).metadata()
  const frames = meta.pages ?? 1
  const rawHeight = meta.pageHeight ?? meta.height
  const rotated = (meta.orientation ?? 1) >= 5
  const width = rotated ? rawHeight : meta.width
  const height = rotated ? meta.width : rawHeight
  if (!width || !height) throw new Error('image has no dimensions')
  const alpha = meta.hasAlpha ? !(await sharp(input).stats()).isOpaque : false

  let colors = Number.POSITIVE_INFINITY
  if (width * height <= MAX_COUNTED_PIXELS) {
    const raw = await sharp(input).ensureAlpha().raw().toBuffer()
    colors = countColors(raw, 256)
  }
  let graphic = colors <= 256
  if (!graphic) {
    const sample = await sharp(input)
      .resize(64, 64, { fit: 'fill', kernel: 'nearest' })
      .ensureAlpha()
      .raw()
      .toBuffer()
    graphic = countColors(sample, 600) < 600
  }
  const format = meta.format === 'heif' ? 'avif' : meta.format
  return {
    format,
    width,
    height,
    alpha,
    animated: frames > 1,
    ...(frames > 1 ? { frames } : {}),
    content: graphic ? 'graphic' : 'photo',
    ...(colors <= 256 ? { colors } : {}),
    ...(meta.icc && !isSrgbProfile(meta.icc) ? { wideGamut: true } : {}),
  }
}
