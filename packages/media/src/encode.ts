import { createHash } from 'node:crypto'

import type { Sharp } from 'sharp'

import { probeImage, requireSharp } from './probe.ts'
import { ssim } from './ssim.ts'
import type {
  EncodeFailure,
  EncodedVariant,
  ImageInfo,
  OutputFormat,
  VariantCache,
  VariantSpec,
} from './types.ts'

export interface EncodeOptions {
  /** Variants encoded at once. Default 2 (sharp already uses several threads per image). */
  concurrency?: number
  signal?: AbortSignal
  /** Probe result of the input, when the caller already has it. */
  info?: ImageInfo
  /** Reuses variants encoded before from the same bytes, spec and encoder versions. */
  cache?: VariantCache
}

/** Encoded variants in spec order, and the specs that failed. */
export interface EncodeResult {
  variants: EncodedVariant[]
  failures: EncodeFailure[]
  /** Variants taken from `cache`, when one was given. */
  cached?: number
}

const SSIM_SIDE = 256
const MAX_SEARCH_STEPS = 6

/** SHA-256 of bytes, hex. */
export const sha256Hex = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

type SharpFactory = Awaited<ReturnType<typeof requireSharp>>

const contentTypes: Record<OutputFormat, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}

/** Libraries whose upgrades change encoded bytes; part of every cache key. */
const encoderLibraries = [
  'sharp',
  'vips',
  'aom',
  'heif',
  'webp',
  'mozjpeg',
  'png',
  'imagequant',
  'cgif',
]

/**
 * Cache key of one variant: `media/v1/<source sha256>/<sha256 of spec and encoder versions>`.
 * Any change to the spec (quality, SSIM target, size, effort) or to sharp's codecs is a new key.
 */
export function variantCacheKey(
  sourceSha256: string,
  spec: VariantSpec,
  versions: Readonly<Record<string, string | undefined>>,
): string {
  const libraries = encoderLibraries.map((name) => `${name}=${versions[name] ?? ''}`).join(',')
  const specKey = Object.entries(spec)
    .filter(([key]) => key !== 'id' && key !== 'replacesOriginal')
    .toSorted(([a], [b]) => a.localeCompare(b))
  return `media/v1/${sourceSha256}/${sha256Hex(new TextEncoder().encode(JSON.stringify([specKey, libraries])))}`
}

const metaNumber = (meta: Record<string, unknown>, key: string) => {
  const value = meta[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A cached variant, or `undefined` when the entry does not describe one for `spec`. */
function fromCache(
  spec: VariantSpec,
  hit: { data: Uint8Array; meta: Record<string, unknown> },
): EncodedVariant | undefined {
  const width = metaNumber(hit.meta, 'width')
  const height = metaNumber(hit.meta, 'height')
  const quality = metaNumber(hit.meta, 'quality')
  const score = metaNumber(hit.meta, 'ssim')
  if (width === undefined || height === undefined || quality === undefined) return undefined
  if (hit.meta.format !== spec.format || hit.data.byteLength === 0) return undefined
  return {
    spec,
    bytes: hit.data.byteLength,
    width,
    height,
    format: spec.format,
    quality,
    ...(score === undefined ? {} : { ssim: score }),
    data: hit.data,
    sha256: sha256Hex(hit.data),
  }
}

function base(sharp: SharpFactory, input: Uint8Array, spec: VariantSpec, info: ImageInfo): Sharp {
  let image = sharp(input, spec.animated ? { animated: true } : {})
  if (!spec.animated) image = image.autoOrient()
  if (spec.width !== info.width || spec.height !== info.height)
    image = image.resize({ width: spec.width, height: spec.height, fit: 'fill' })
  if (info.wideGamut) image = image.keepIccProfile()
  return image
}

function encoder(image: Sharp, spec: VariantSpec, quality: number): Sharp {
  switch (spec.format) {
    case 'avif':
      return image.avif({
        quality,
        effort: spec.effort,
        ...(spec.lossless ? { lossless: true } : {}),
        ...(spec.chromaSubsampling ? { chromaSubsampling: spec.chromaSubsampling } : {}),
      })
    case 'webp':
      return image.webp({
        quality,
        effort: spec.effort,
        ...(spec.lossless ? { lossless: true } : {}),
        ...(spec.nearLossless ? { nearLossless: true } : {}),
        ...(spec.alphaQuality === undefined ? {} : { alphaQuality: spec.alphaQuality }),
        ...(spec.lossless || spec.nearLossless ? {} : { smartSubsample: true }),
      })
    case 'png':
      return spec.palette
        ? image.png({
            palette: true,
            quality: 100,
            dither: 0,
            effort: spec.effort,
            compressionLevel: 9,
          })
        : image.png({ compressionLevel: 9, adaptiveFiltering: true })
    case 'jpeg':
      return image.jpeg({ quality, mozjpeg: true })
  }
  return image.gif({ effort: spec.effort })
}

async function luma(
  sharp: SharpFactory,
  image: Sharp,
  size?: { width: number; height: number },
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const resized = size
    ? image.resize({ width: size.width, height: size.height, fit: 'fill' })
    : image.resize({ width: SSIM_SIDE, height: SSIM_SIDE, fit: 'inside', withoutEnlargement: true })
  const { data, info } = await sharp(
    await resized.flatten({ background: '#ffffff' }).greyscale().png().toBuffer(),
  )
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), width: info.width, height: info.height }
}

async function encodeOne(
  sharp: SharpFactory,
  input: Uint8Array,
  spec: VariantSpec,
  info: ImageInfo,
  signal?: AbortSignal,
): Promise<EncodedVariant> {
  const run = async (quality: number) => {
    const { data, info: out } = await encoder(
      base(sharp, input, spec, info),
      spec,
      quality,
    ).toBuffer({
      resolveWithObject: true,
    })
    return { data: new Uint8Array(data), width: out.width, height: out.pageHeight ?? out.height }
  }
  const finish = (
    result: { data: Uint8Array; width: number; height: number },
    quality: number,
    score?: number,
  ): EncodedVariant => ({
    spec,
    bytes: result.data.byteLength,
    width: result.width,
    height: result.height,
    format: spec.format,
    quality,
    ...(score === undefined ? {} : { ssim: Math.round(score * 10_000) / 10_000 }),
    data: result.data,
    sha256: sha256Hex(result.data),
  })

  if (spec.targetSsim === undefined || spec.animated)
    return finish(await run(spec.quality), spec.quality)

  const reference = await luma(sharp, base(sharp, input, spec, info))
  const score = async (data: Uint8Array) => {
    const candidate = await luma(sharp, sharp(data), reference)
    return ssim(reference.data, candidate.data, reference.width, reference.height)
  }
  let low = Math.min(spec.minQuality ?? spec.quality, spec.quality)
  let high = spec.quality
  let best: { result: Awaited<ReturnType<typeof run>>; quality: number; score: number } | undefined
  for (let step = 0; step < MAX_SEARCH_STEPS && low <= high; step++) {
    signal?.throwIfAborted()
    const quality = Math.floor((low + high) / 2)
    const result = await run(quality)
    const value = await score(result.data)
    if (value >= spec.targetSsim) {
      best = { result, quality, score: value }
      high = quality - 1
    } else low = quality + 1
  }
  if (best) return finish(best.result, best.quality, best.score)
  const result = await run(spec.quality)
  return finish(result, spec.quality, await score(result.data))
}

/**
 * Encodes every spec from one source image with sharp: EXIF orientation applied, metadata
 * stripped, ICC kept only for non-sRGB sources. Specs with `targetSsim` binary-search their
 * quality (at most six encodes) against the source at the same size. A spec that fails is
 * reported in `failures`, not thrown; an aborted signal throws. With `cache`, variants encoded
 * before from the same bytes, spec and encoder versions are reused and new ones stored.
 */
export async function encodeVariants(
  input: Uint8Array,
  specs: readonly VariantSpec[],
  options: EncodeOptions = {},
): Promise<EncodeResult> {
  const sharp = await requireSharp()
  const info = options.info ?? (await probeImage(input))
  const results: (EncodedVariant | EncodeFailure | undefined)[] = Array.from({
    length: specs.length,
  })
  const { cache } = options
  const sourceSha256 = cache ? sha256Hex(input) : ''
  let cached = 0
  const encode = async (spec: VariantSpec): Promise<EncodedVariant> => {
    if (!cache) return encodeOne(sharp, input, spec, info, options.signal)
    const key = variantCacheKey(sourceSha256, spec, sharp.versions)
    const hit = await cache.get(key)
    const reused = hit && fromCache(spec, hit)
    if (reused) {
      cached++
      return reused
    }
    const variant = await encodeOne(sharp, input, spec, info, options.signal)
    await cache.set(key, variant.data, {
      contentType: contentTypes[variant.format],
      meta: {
        format: variant.format,
        width: variant.width,
        height: variant.height,
        quality: variant.quality,
        ...(variant.ssim === undefined ? {} : { ssim: variant.ssim }),
      },
    })
    return variant
  }
  let next = 0
  const worker = async () => {
    while (next < specs.length) {
      options.signal?.throwIfAborted()
      const index = next++
      const spec = specs[index]
      if (!spec) continue
      try {
        results[index] = await encode(spec)
      } catch (error) {
        if (options.signal?.aborted) throw error
        results[index] = { spec, error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker))
  const variants: EncodedVariant[] = []
  const failures: EncodeFailure[] = []
  for (const result of results) {
    if (!result) continue
    if ('error' in result) failures.push(result)
    else variants.push(result)
  }
  return { variants, failures, ...(cache ? { cached } : {}) }
}
