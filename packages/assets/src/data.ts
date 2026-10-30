import { codeChangeSchema } from '@holtkeeper/media'
import { z } from 'zod'

/** What a file is to the runtime that loads it, by extension and, for JSON, by content. */
export const assetKinds = [
  'image',
  'audio',
  'video',
  'font',
  'atlas',
  'model',
  'data',
  'other',
] as const

export type AssetKind = (typeof assetKinds)[number]

const kindSchema = z.enum(assetKinds)

const imageMetaSchema = z.object({
  width: z.number(),
  height: z.number(),
  alpha: z.boolean().optional(),
  bitDepth: z.number().optional(),
  animated: z.boolean().optional(),
  frames: z.number().optional(),
  /** `lossy` / `lossless` for WebP, the PNG color type name, ... */
  codec: z.string().optional(),
})

const audioMetaSchema = z.object({
  durationMs: z.number().optional(),
  sampleRate: z.number().optional(),
  channels: z.number().optional(),
  /** Bits per second, average over the file. */
  bitrate: z.number().optional(),
  codec: z.string().optional(),
})

const videoMetaSchema = z.object({
  durationMs: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
})

const fontMetaSchema = z.object({
  format: z.enum(['truetype', 'opentype', 'collection', 'woff', 'woff2']),
  glyphs: z.number().optional(),
})

const atlasMetaSchema = z.object({
  frames: z.number().optional(),
  /** Texture files the atlas points at, as written in it. */
  images: z.array(z.string()),
})

export type ImageMeta = z.infer<typeof imageMetaSchema>
export type AudioMeta = z.infer<typeof audioMetaSchema>
export type VideoMeta = z.infer<typeof videoMetaSchema>
export type FontMeta = z.infer<typeof fontMetaSchema>
export type AtlasMeta = z.infer<typeof atlasMetaSchema>

/** Header metadata of one file; only the part matching its kind is set, and only when parsable. */
const assetMetaSchema = z.object({
  image: imageMetaSchema.optional(),
  audio: audioMetaSchema.optional(),
  video: videoMetaSchema.optional(),
  font: fontMetaSchema.optional(),
  atlas: atlasMetaSchema.optional(),
})

export type AssetMeta = z.infer<typeof assetMetaSchema>

const assetSchema = assetMetaSchema.extend({
  /** Repository-relative path with `/` separators. */
  path: z.string(),
  kind: kindSchema,
  /** Lowercase extension without the dot, e.g. `png`. */
  format: z.string(),
  bytes: z.number(),
  /** Gzip (level 9) size, for text formats only (SVG, JSON, atlases, glTF). */
  gzip: z.number().optional(),
  /** SHA-256 of the content, hex, first 16 characters. */
  hash: z.string(),
  /** `build`: found under the build output; `source`: everywhere else. */
  origin: z.enum(['source', 'build']),
  /** Whether the file name appears in source or config files; unset when not checked. */
  referenced: z.boolean().optional(),
})

/** One inventoried file. */
export type Asset = z.infer<typeof assetSchema>

const kindTotalSchema = z.object({ kind: kindSchema, count: z.number(), bytes: z.number() })

/** Bytes and files of one kind. Build files identical to a source file are counted once. */
export type KindTotal = z.infer<typeof kindTotalSchema>

const budgetViolationSchema = z.object({
  id: z.string(),
  /** Unset for a total budget. */
  path: z.string().optional(),
  /** Glob of the per-asset budget; unset for a total budget. */
  pattern: z.string().optional(),
  kind: kindSchema.optional(),
  limit: z.enum(['bytes', 'width', 'height', 'total']),
  actual: z.number(),
  max: z.number(),
})

/** An asset, or the total of a kind, above a configured budget. */
export type BudgetViolation = z.infer<typeof budgetViolationSchema>

const findingRules = ['huge-dimensions', 'non-power-of-two', 'unused'] as const

export type FindingRule = (typeof findingRules)[number]

const findingSchema = z.object({
  id: z.string(),
  rule: z.enum(findingRules),
  path: z.string(),
  tone: z.enum(['info', 'warning', 'bad']),
  title: z.string(),
  detail: z.string().optional(),
})

/** A problem that is not a budget: oversized textures, unused-looking files. */
export type Finding = z.infer<typeof findingSchema>

const suggestionRules = [
  'opaque-png',
  'alpha-png',
  'jpeg',
  'animated-gif',
  'uncompressed-audio',
  'desktop-font',
  'svg',
] as const

export type SuggestionRule = (typeof suggestionRules)[number]

const suggestionSchema = z.object({
  id: z.string(),
  rule: z.enum(suggestionRules),
  path: z.string(),
  kind: kindSchema,
  format: z.string(),
  bytes: z.number(),
  /** Target format, e.g. `webp`, `avif`, `ogg`, `woff2`. */
  suggested: z.string(),
  /** How to produce it, e.g. `cwebp -lossless`. */
  how: z.string(),
  /** Size after conversion: measured with a tool, or estimated from conservative ratios. */
  expectedBytes: z.number(),
  method: z.enum(['estimate', 'measured']),
  saving: z.number(),
})

/** A conversion that would make an asset smaller. */
export type Suggestion = z.infer<typeof suggestionSchema>

const duplicateSchema = z.object({
  hash: z.string(),
  bytes: z.number(),
  paths: z.array(z.string()),
})

/** Files with identical content; `paths` has at least two entries, sorted. */
export type Duplicate = z.infer<typeof duplicateSchema>

export const imageVariantSchema = z.object({
  /** Plan id, e.g. `avif-640w`, `webp@2x`. */
  id: z.string(),
  format: z.enum(['avif', 'webp', 'png', 'jpeg', 'gif']),
  width: z.number(),
  height: z.number(),
  density: z.number().optional(),
  bytes: z.number(),
  quality: z.number(),
  ssim: z.number().optional(),
  /** SHA-256 of the encoded file, hex; the `artifact` of its `write-binary` edit. */
  sha256: z.string(),
  /** Repository path the variant is written to. */
  file: z.string(),
  /** Written over the original file. */
  replacesOriginal: z.boolean().optional(),
  /** Part of the proposed change (smaller than the original, format worth shipping). */
  proposed: z.boolean(),
})

/** One encoded variant of an image; sizes only, the bytes are run artifacts. */
export type ImageVariant = z.infer<typeof imageVariantSchema>

export const imageOptimizationSchema = z.object({
  path: z.string(),
  format: z.string(),
  bytes: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  usage: z.enum(['responsive', 'fixed', 'texture']).optional(),
  variants: z.array(imageVariantSchema),
  skipped: z.array(z.object({ format: z.string(), reason: z.string() })),
  /** Smallest full-size variant. */
  best: z
    .object({
      format: z.string(),
      bytes: z.number(),
      saving: z.number(),
      savingPercent: z.number(),
    })
    .optional(),
  /** Markup and CSS usages found and rewritten by the change. */
  references: z.array(
    z.object({ file: z.string(), line: z.number(), kind: z.enum(['img', 'css']) }),
  ),
  /** Id of the proposed change, when there is one. */
  changeId: z.string().optional(),
  /** Why the image could not be optimized (undecodable, encoder failure). */
  error: z.string().optional(),
})

/** Real variants measured with sharp for one image. */
export type ImageOptimization = z.infer<typeof imageOptimizationSchema>

const pathStatsSchema = z.object({
  paths: z.number(),
  commands: z.number(),
  coordinates: z.number(),
  digits: z.number(),
  longest: z.array(z.object({ length: z.number(), id: z.string().optional() })),
})

export const svgOptimizationSchema = z.object({
  path: z.string(),
  preset: z.enum(['safe', 'default', 'aggressive']),
  bytes: z.object({ before: z.number(), after: z.number() }),
  gzip: z.object({ before: z.number(), after: z.number() }),
  breakdown: z.object({
    removedElements: z.record(z.string(), z.number()),
    removedAttributes: z.record(z.string(), z.number()),
    metadata: z.number(),
    comments: z.number(),
    paths: z.object({ before: pathStatsSchema, after: pathStatsSchema }),
    styles: z.object({
      inlineBefore: z.number(),
      inlineAfter: z.number(),
      elementsBefore: z.number(),
      elementsAfter: z.number(),
    }),
    ids: z.object({ before: z.number(), after: z.number(), minified: z.number() }),
    issues: z.array(z.object({ code: z.string(), message: z.string() })),
  }),
  changeId: z.string().optional(),
  error: z.string().optional(),
})

/** svgo result for one SVG, without the optimized text (that lives in the change). */
export type SvgOptimizationData = z.infer<typeof svgOptimizationSchema>

export const assetsDataSchema = z.object({
  /** Globs that were scanned. */
  roots: z.array(z.string()),
  /** Game engines found in package.json files, e.g. `phaser`, `three`. */
  engines: z.array(z.string()),
  convert: z.enum(['sharp', 'estimate', 'tools', 'off']),
  /** Converters that measured at least one suggestion. */
  tools: z.array(z.string()),
  assets: z.array(assetSchema),
  totals: z.array(kindTotalSchema),
  budgets: z.array(budgetViolationSchema),
  findings: z.array(findingSchema),
  suggestions: z.array(suggestionSchema),
  duplicates: z.array(duplicateSchema),
  /** Images measured with sharp (`convert: 'sharp'`), largest first. */
  optimized: z.array(imageOptimizationSchema).optional(),
  /** SVGs optimized with svgo (`convert: 'sharp'`), largest first. */
  svgs: z.array(svgOptimizationSchema).optional(),
  /** Proposed changes: SVG rewrites, image variants and markup swaps. */
  changes: z.array(codeChangeSchema).optional(),
})

/** Result of one `assets` analysis; assets are sorted by path. */
export type AssetsData = z.infer<typeof assetsDataSchema>

export const budgetSchema = z.object({
  /** Glob over repository-relative paths, e.g. `public/textures/**`. */
  pattern: z.string(),
  maxBytes: z.coerce.number().positive().optional(),
  maxWidth: z.coerce.number().positive().optional(),
  maxHeight: z.coerce.number().positive().optional(),
  /** Only assets of this kind. */
  kind: kindSchema.optional(),
})

/** A per-asset limit. Every asset matching `pattern` (and `kind`) must stay within each set limit. */
export type Budget = z.infer<typeof budgetSchema>

/** Maximum total bytes per kind. */
export const totalBudgetsSchema = z.partialRecord(kindSchema, z.coerce.number().positive())

export type TotalBudgets = z.infer<typeof totalBudgetsSchema>
