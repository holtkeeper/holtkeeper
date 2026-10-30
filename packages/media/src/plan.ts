import type {
  ImageInfo,
  ImageUsage,
  OutputFormat,
  SkippedFormat,
  VariantPlan,
  VariantSpec,
} from './types.ts'

/** Responsive widths in CSS-pixel steps common to phones, tablets and desktops at DPR 1–2. */
export const defaultWidths = [320, 640, 960, 1280, 1920, 2560]

/** Starting qualities that keep artifacts invisible on typical content at each encoder's scale. */
export const defaultQuality: Record<OutputFormat, number> = {
  avif: 55,
  webp: 78,
  jpeg: 78,
  png: 100,
  gif: 100,
}

/** Encoder effort per level, on each encoder's own scale. */
const efforts: Record<'fast' | 'default' | 'max', Record<OutputFormat, number>> = {
  fast: { avif: 2, webp: 2, png: 3, jpeg: 0, gif: 3 },
  default: { avif: 4, webp: 4, png: 7, jpeg: 0, gif: 7 },
  max: { avif: 7, webp: 6, png: 10, jpeg: 0, gif: 10 },
}

export interface PlanOptions {
  /** Output formats; default AVIF, WebP and the source format re-encoded. */
  formats?: OutputFormat[]
  /** Default `responsive`, or `fixed` when `displayWidth` is set. */
  usage?: ImageUsage
  /** Responsive width ladder; default `defaultWidths`, capped at the source width. */
  widths?: number[]
  /** CSS width the image is shown at, for `fixed` usage. */
  displayWidth?: number
  /** Density ladder; default `[1, 2, 3]` for `fixed`, `[1, 2]` for `texture` (source = highest). */
  densities?: number[]
  /** One quality for every lossy format, or per format; default `defaultQuality`. */
  quality?: number | Partial<Record<OutputFormat, number>>
  /**
   * Search the lowest quality keeping SSIM (downscaled luma) at or above this, e.g. `0.985`.
   * The search spans 30 points below the format's quality and up to it.
   */
  targetSsim?: number
  effort?: 'fast' | 'default' | 'max'
}

/** The format a source is re-encoded to: itself when an encoder exists, else PNG or JPEG. */
export function originalOutput(info: ImageInfo): OutputFormat {
  switch (info.format) {
    case 'png':
      return 'png'
    case 'webp':
      return 'webp'
    case 'avif':
      return 'avif'
    case 'gif':
      return 'gif'
    case 'jpeg':
    case 'jpg':
      return 'jpeg'
    default:
      return info.alpha || info.content === 'graphic' ? 'png' : 'jpeg'
  }
}

const unique = (values: number[]) => [...new Set(values)].toSorted((a, b) => a - b)

interface Size {
  width: number
  density?: number
  top: boolean
}

function sizesFor(info: ImageInfo, usage: ImageUsage, options: PlanOptions): Size[] {
  if (usage === 'texture') {
    const densities = unique(options.densities ?? [1, 2])
    const top = densities.at(-1) ?? 1
    return densities
      .map((density) => ({
        width: Math.max(1, Math.round((info.width * density) / top)),
        density,
        top: density === top,
      }))
      .filter((size, index, all) => all.findIndex((other) => other.width === size.width) === index)
  }
  if (usage === 'fixed' && options.displayWidth) {
    const display = options.displayWidth
    const sizes: Size[] = []
    for (const density of unique(options.densities ?? [1, 2, 3])) {
      const width = Math.round(display * density)
      if (width <= info.width) sizes.push({ width, density, top: width === info.width })
      else if (!sizes.some((size) => size.width === info.width))
        sizes.push({ width: info.width, density, top: true })
    }
    return sizes
  }
  const ladder = unique(options.widths ?? defaultWidths)
  const widths = ladder.filter((width) => width < info.width)
  const max = ladder.at(-1) ?? info.width
  if (info.width <= max) widths.push(info.width)
  return widths.map((width) => ({ width, top: width === info.width }))
}

function qualityOf(format: OutputFormat, options: PlanOptions): number {
  const value = typeof options.quality === 'number' ? options.quality : options.quality?.[format]
  return Math.min(100, Math.max(1, Math.round(value ?? defaultQuality[format])))
}

/**
 * The variants worth encoding for an image: formats × sizes with per-format settings. Alpha and
 * flat graphics get settings that keep edges clean (AVIF 4:4:4, WebP exact alpha or lossless,
 * PNG palette only when it is lossless); animated sources keep only encoders sharp can animate.
 * Sizes never exceed the source.
 */
export function planVariants(info: ImageInfo, options: PlanOptions = {}): VariantPlan {
  const usage: ImageUsage = options.usage ?? (options.displayWidth ? 'fixed' : 'responsive')
  const original = originalOutput(info)
  const requested = [...new Set<OutputFormat>(options.formats ?? ['avif', 'webp', original])]
  const skipped: SkippedFormat[] = []
  const formats = requested.filter((format) => {
    if (info.animated) {
      if (format === 'avif') {
        skipped.push({ format, reason: 'sharp cannot encode animated AVIF' })
        return false
      }
      if (format === 'png' || format === 'jpeg') {
        skipped.push({ format, reason: `${format.toUpperCase()} cannot keep the animation` })
        return false
      }
    } else if (format === 'gif' && original !== 'gif') {
      skipped.push({ format, reason: 'GIF is never smaller for a still image' })
      return false
    }
    if (format === 'jpeg' && info.alpha) {
      skipped.push({ format, reason: 'JPEG has no alpha channel' })
      return false
    }
    return true
  })
  const effort = efforts[options.effort ?? 'default']
  const sizes: Size[] = info.animated
    ? [{ width: info.width, top: true }]
    : sizesFor(info, usage, options)
  const graphic = info.content === 'graphic'
  const exactPalette = info.colors !== undefined && info.colors <= 256

  const specs: VariantSpec[] = []
  for (const format of formats) {
    const quality = qualityOf(format, options)
    for (const size of sizes) {
      const height = Math.max(1, Math.round((info.height * size.width) / info.width))
      const id =
        size.density === undefined ? `${format}-${size.width}w` : `${format}@${size.density}x`
      const spec: VariantSpec = {
        id,
        format,
        width: size.width,
        height,
        ...(size.density === undefined ? {} : { density: size.density }),
        quality,
        effort: effort[format],
        ...(info.animated ? { animated: true } : {}),
        ...(format === original && size.top && usage !== 'texture'
          ? { replacesOriginal: true }
          : {}),
      }
      if (format === 'avif') {
        if (info.alpha || graphic) {
          spec.chromaSubsampling = '4:4:4'
          if (info.alpha) spec.quality = Math.max(quality, 70)
        } else spec.chromaSubsampling = '4:2:0'
      } else if (format === 'webp') {
        if (graphic && !info.animated) {
          if (exactPalette) spec.lossless = true
          else {
            spec.nearLossless = true
            spec.quality = 60
          }
        } else if (info.alpha) spec.alphaQuality = 100
      } else if (format === 'png') {
        if (exactPalette) spec.palette = true
        else spec.lossless = true
      } else if (format === 'gif') spec.lossless = true
      const lossy = !spec.lossless && !spec.nearLossless && format !== 'png' && format !== 'gif'
      if (options.targetSsim !== undefined && lossy) {
        spec.targetSsim = options.targetSsim
        spec.minQuality = Math.max(10, spec.quality - 30)
      }
      specs.push(spec)
    }
  }
  return { usage, specs, skipped }
}
