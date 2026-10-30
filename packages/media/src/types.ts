/** Raster formats variants are encoded to. */
export const outputFormats = ['avif', 'webp', 'png', 'jpeg', 'gif'] as const

export type OutputFormat = (typeof outputFormats)[number]

/** What an image is, as far as encoders care. */
export interface ImageInfo {
  /** Source format as sharp reports it: `png`, `jpeg`, `webp`, `gif`, `avif` (`heif`), `tiff`, ... */
  format: string
  /** Display width after EXIF orientation. */
  width: number
  /** Display height after EXIF orientation. */
  height: number
  /** Has an alpha channel that is not fully opaque. */
  alpha: boolean
  /** More than one frame (animated GIF, WebP or APNG). */
  animated: boolean
  /** Frames, when animated. */
  frames?: number
  /** `graphic`: flat art with few colors (logos, UI); `photo`: continuous tone. */
  content: 'photo' | 'graphic'
  /** Exact number of distinct RGBA colors, when it is at most 256 (palette PNG is then lossless). */
  colors?: number
  /** Carries an ICC profile that is not sRGB, so it must be kept. */
  wideGamut?: boolean
}

/** How an image is shown, which decides the size ladder. */
export type ImageUsage =
  /** Responsive `<img>`/background: width descriptors (`320w`, `640w`, ...). */
  | 'responsive'
  /** Fixed CSS size (`displayWidth`): density descriptors `@1x`, `@2x`, `@3x`. */
  | 'fixed'
  /** Game texture: the source is the highest density, lower ones are scaled down. */
  | 'texture'

/** One file to produce from a source image. */
export interface VariantSpec {
  /** Stable within a plan, e.g. `avif-640w`, `webp@2x`. */
  id: string
  format: OutputFormat
  /** Output width; height follows the aspect ratio. */
  width: number
  height: number
  /** Set for density variants (`fixed` and `texture` usage). */
  density?: number
  /** Encoder quality 1–100; ignored when `lossless`. */
  quality: number
  /** Search the lowest quality whose SSIM stays at or above this value, between `minQuality` and `quality`. */
  targetSsim?: number
  minQuality?: number
  lossless?: boolean
  /** WebP near-lossless preprocessing (uses `quality` as its level). */
  nearLossless?: boolean
  /** WebP alpha plane quality; 100 keeps alpha edges exact. */
  alphaQuality?: number
  /** PNG palette quantization (lossless for images with at most 256 colors). */
  palette?: boolean
  /** AVIF chroma subsampling; `4:4:4` for alpha and graphics. */
  chromaSubsampling?: '4:2:0' | '4:4:4'
  /** Encoder CPU effort, format specific scale. */
  effort: number
  /** Keep all frames. */
  animated?: boolean
  /** Same format and size as the source: written over the original file instead of next to it. */
  replacesOriginal?: boolean
}

/** A format the plan left out, and why. */
export interface SkippedFormat {
  format: OutputFormat
  reason: string
}

/** The variants worth producing for one image. */
export interface VariantPlan {
  usage: ImageUsage
  specs: VariantSpec[]
  skipped: SkippedFormat[]
}

/** One encoded variant. `data` is the file content; everything else is JSON-safe. */
export interface EncodedVariant {
  spec: VariantSpec
  bytes: number
  width: number
  height: number
  format: OutputFormat
  /** Quality actually used (after an SSIM search). */
  quality: number
  /** SSIM against the source at the same size, when a search ran. */
  ssim?: number
  data: Uint8Array
  /** SHA-256 of `data`, hex. */
  sha256: string
}

/** A variant that could not be encoded. */
export interface EncodeFailure {
  spec: VariantSpec
  error: string
}
