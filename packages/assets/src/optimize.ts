import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type Artifact,
  type CodeChange,
  type Edit,
  type EncodedVariant,
  type ImageInfo,
  type ImageUsage,
  type NamingScheme,
  type SvgPreset,
  type VariantCache,
  encodeVariants,
  formatOfFile,
  imageSetValue,
  pictureSnippets,
  planVariants,
  probeImage,
  rangeOf,
  replaceFile,
  sha256Hex,
  optimizeSvg,
  variantFile,
} from '@holtkeeper/media'

import type { Asset, ImageOptimization, ImageVariant, SvgOptimizationData } from './data.ts'
import type { ImageReference } from './usages.ts'

/** Raster formats sharp re-encodes. */
export const optimizableFormats = new Set(['png', 'apng', 'jpg', 'jpeg', 'gif', 'webp'])

export interface OptimizeOptions {
  dir: string
  /** Candidates, already filtered and ranked. */
  rasters: readonly Asset[]
  svgs: readonly Asset[]
  /** Usages per image path, from `findReferences`. */
  references: ReadonlyMap<string, ImageReference[]>
  /** File texts the references point into. */
  sources: ReadonlyMap<string, string>
  engines: readonly string[]
  /** Variants and SVGs saving less are not proposed. */
  minSaving: number
  svgPreset: SvgPreset
  naming?: NamingScheme
  /** Encoded variants kept between runs; hits skip sharp. */
  cache?: VariantCache
  signal?: AbortSignal
  log?: (line: string) => void
}

export interface OptimizeResult {
  images: ImageOptimization[]
  svgs: SvgOptimizationData[]
  changes: CodeChange[]
  artifacts: Artifact[]
}

const percent = (original: number, bytes: number) =>
  original > 0 ? Math.round(((original - bytes) / original) * 1000) / 10 : 0

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** How an image is shown: fixed when every `<img>` gives one width, texture in game projects without markup usages. */
export function usageOf(
  references: readonly ImageReference[],
  engines: readonly string[],
): { usage: ImageUsage; displayWidth?: number } {
  const imgs = references.filter((reference) => reference.kind === 'img')
  const widths = new Set(imgs.map((reference) => reference.width))
  const [width] = widths
  if (imgs.length && widths.size === 1 && width !== undefined)
    return { usage: 'fixed', displayWidth: width }
  if (engines.length && !references.length) return { usage: 'texture' }
  return { usage: 'responsive' }
}

/**
 * Which encoded variants to ship: a format is kept when its largest variant is smaller than the
 * original by at least `minSaving`; the original-format re-encode only when it saves that much too.
 */
export function proposedVariants(
  original: number,
  variants: readonly EncodedVariant[],
  minSaving: number,
): Set<EncodedVariant> {
  const kept = new Set<EncodedVariant>()
  for (const format of new Set(variants.map((variant) => variant.format))) {
    const list = variants
      .filter((variant) => variant.format === format)
      .toSorted((a, b) => a.width - b.width)
    const largest = list.at(-1)
    if (!largest || original - largest.bytes < minSaving) continue
    for (const variant of list) kept.add(variant)
  }
  return kept
}

function swapEdit(
  reference: ImageReference,
  variants: readonly ImageVariant[],
  info: ImageInfo,
  naming: NamingScheme | undefined,
  source: string,
): Edit {
  const snippetVariants = variants.map((variant) => ({
    format: variant.format,
    width: variant.width,
    ...(variant.density === undefined ? {} : { density: variant.density }),
    ...(variant.replacesOriginal ? { replacesOriginal: true } : {}),
  }))
  let newText: string
  if (reference.kind === 'css') {
    const set = imageSetValue({
      file: reference.src,
      variants: snippetVariants,
      ...(naming ? { naming } : {}),
    })
    const value = (reference.value ?? '').replace(/url\(\s*(["']?)[^"')]+\1\s*\)/, set)
    newText = `${reference.text}${reference.text.endsWith(';') ? '' : ';'}\n${reference.indent}${reference.property}: ${value};`
  } else {
    newText = pictureSnippets({
      file: reference.src,
      variants: snippetVariants,
      framework: reference.framework === 'css' ? 'html' : reference.framework,
      alt: reference.alt ?? '',
      width: reference.width ?? info.width,
      height:
        reference.height ??
        (reference.width ? Math.round((info.height * reference.width) / info.width) : info.height),
      indent: reference.indent,
      ...(reference.attributes ? { attributes: reference.attributes } : {}),
      ...(naming ? { naming } : {}),
    }).code
  }
  return {
    kind: 'replace',
    file: reference.file,
    range: rangeOf(source, reference.start, reference.end),
    oldText: reference.text,
    newText,
  }
}

async function optimizeRaster(
  asset: Asset,
  options: OptimizeOptions,
): Promise<{ image: ImageOptimization; change?: CodeChange; artifacts: Artifact[] }> {
  const references = options.references.get(asset.path) ?? []
  const image: ImageOptimization = {
    path: asset.path,
    format: asset.format,
    bytes: asset.bytes,
    variants: [],
    skipped: [],
    references: [],
  }
  let input: Uint8Array
  let info: ImageInfo
  try {
    input = new Uint8Array(await readFile(join(options.dir, asset.path)))
    info = await probeImage(input)
  } catch (error) {
    return { image: { ...image, error: `cannot decode: ${message(error)}` }, artifacts: [] }
  }
  const { usage, displayWidth } = usageOf(references, options.engines)
  const plan = planVariants(info, { usage, ...(displayWidth ? { displayWidth } : {}) })
  const { variants, failures, cached } = await encodeVariants(input, plan.specs, {
    info,
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (cached)
    options.log?.(`assets: ${asset.path} ${cached}/${plan.specs.length} variants from cache`)
  const kept = proposedVariants(asset.bytes, variants, options.minSaving)
  const stored: ImageVariant[] = variants.map((variant) => ({
    id: variant.spec.id,
    format: variant.format,
    width: variant.width,
    height: variant.height,
    ...(variant.spec.density === undefined ? {} : { density: variant.spec.density }),
    bytes: variant.bytes,
    quality: variant.quality,
    ...(variant.ssim === undefined ? {} : { ssim: variant.ssim }),
    sha256: variant.sha256,
    file: variantFile(asset.path, variant.spec, options.naming),
    ...(variant.spec.replacesOriginal ? { replacesOriginal: true } : {}),
    proposed: kept.has(variant),
  }))
  const full = stored
    .filter(
      (variant) =>
        variant.width ===
        Math.max(
          ...stored.filter((other) => other.format === variant.format).map((other) => other.width),
        ),
    )
    .toSorted((a, b) => a.bytes - b.bytes)[0]
  const result: ImageOptimization = {
    ...image,
    width: info.width,
    height: info.height,
    usage,
    variants: stored,
    skipped: [
      ...plan.skipped,
      ...failures.map((failure) => ({
        format: failure.spec.format,
        reason: `${failure.spec.id}: ${failure.error}`,
      })),
    ],
    ...(full
      ? {
          best: {
            format: full.format,
            bytes: full.bytes,
            saving: asset.bytes - full.bytes,
            savingPercent: percent(asset.bytes, full.bytes),
          },
        }
      : {}),
  }
  const proposed = stored.filter((variant) => variant.proposed)
  if (!proposed.length) return { image: result, artifacts: [] }

  const previousSha256 = sha256Hex(input)
  const edits: Edit[] = proposed.map((variant) => ({
    kind: 'write-binary',
    file: variant.file,
    bytes: variant.bytes,
    artifact: variant.sha256,
    ...(variant.replacesOriginal ? { previousSha256 } : {}),
  }))
  const original = formatOfFile(asset.path)
  const usable = proposed.filter(
    (variant) =>
      variant.format === 'avif' || variant.format === 'webp' || variant.format === original,
  )
  const swapped = references.filter((reference) => options.sources.has(reference.file))
  for (const reference of swapped) {
    edits.push(
      swapEdit(reference, usable, info, options.naming, options.sources.get(reference.file) ?? ''),
    )
  }
  result.references = swapped.map((reference) => ({
    file: reference.file,
    line: reference.line,
    kind: reference.kind,
  }))
  const lossyReplace = proposed.some(
    (variant) =>
      variant.replacesOriginal && (variant.format === 'jpeg' || variant.format === 'webp'),
  )
  const formats = [...new Set(proposed.map((variant) => variant.format))].join(', ')
  const id = `assets:image:${asset.path}`
  result.changeId = id
  const change: CodeChange = {
    id,
    title: swapped.length
      ? `Serve ${asset.path} as ${formats} with responsive variants`
      : `Add ${formats} variants of ${asset.path}`,
    description: [
      `${proposed.length} variant${proposed.length === 1 ? '' : 's'} (${formats}) encoded with sharp`,
      ...(result.best
        ? [`best full-size ${result.best.format} saves ${result.best.savingPercent}%`]
        : []),
      ...(swapped.length
        ? [
            `rewrites ${swapped.length} usage${swapped.length === 1 ? '' : 's'} to <picture>/image-set()`,
          ]
        : []),
    ].join('; '),
    confidence: swapped.length || lossyReplace ? 'review' : 'safe',
    source: 'sharp',
    edits,
  }
  const artifacts = variants
    .filter((variant) => kept.has(variant))
    .map((variant) => ({ sha256: variant.sha256, bytes: variant.bytes, data: variant.data }))
  return { image: result, change, artifacts }
}

const MAX_SVG_CHANGE_BYTES = 512 * 1024

async function optimizeVector(
  asset: Asset,
  options: OptimizeOptions,
): Promise<{ svg: SvgOptimizationData; change?: CodeChange }> {
  const empty = {
    path: asset.path,
    preset: options.svgPreset,
    bytes: { before: asset.bytes, after: asset.bytes },
    gzip: { before: asset.gzip ?? 0, after: asset.gzip ?? 0 },
  }
  let text: string
  try {
    text = await readFile(join(options.dir, asset.path), 'utf8')
  } catch (error) {
    return { svg: { ...empty, breakdown: emptyBreakdown(), error: message(error) } }
  }
  let result: ReturnType<typeof optimizeSvg>
  try {
    result = optimizeSvg(text, { preset: options.svgPreset })
  } catch (error) {
    return { svg: { ...empty, breakdown: emptyBreakdown(), error: `svgo: ${message(error)}` } }
  }
  const svg: SvgOptimizationData = {
    path: asset.path,
    preset: result.preset,
    bytes: result.bytes,
    gzip: result.gzip,
    breakdown: result.breakdown,
  }
  const saving = result.bytes.before - result.bytes.after
  const worth = saving >= Math.min(options.minSaving, Math.max(64, result.bytes.before * 0.02))
  if (!worth || result.bytes.before > MAX_SVG_CHANGE_BYTES) return { svg }
  const id = `assets:svg:${asset.path}`
  svg.changeId = id
  return {
    svg,
    change: {
      id,
      title: `Optimize ${asset.path} with svgo (${result.preset})`,
      description: `${result.bytes.before} → ${result.bytes.after} bytes, gzip ${result.gzip.before} → ${result.gzip.after}`,
      confidence: result.preset === 'safe' ? 'safe' : 'review',
      source: 'svgo',
      edits: [replaceFile(asset.path, text, result.text)],
    },
  }
}

function emptyBreakdown(): SvgOptimizationData['breakdown'] {
  const stats = { paths: 0, commands: 0, coordinates: 0, digits: 0, longest: [] }
  return {
    removedElements: {},
    removedAttributes: {},
    metadata: 0,
    comments: 0,
    paths: { before: stats, after: stats },
    styles: { inlineBefore: 0, inlineAfter: 0, elementsBefore: 0, elementsAfter: 0 },
    ids: { before: 0, after: 0, minified: 0 },
    issues: [],
  }
}

/**
 * Encodes real variants of raster candidates with sharp and optimizes SVGs with svgo, one image
 * at a time; never writes to `dir`. Proposed variants become `write-binary` edits whose
 * `artifact` is the variant's SHA-256, and their bytes are returned in `artifacts`.
 */
export async function optimizeAssets(options: OptimizeOptions): Promise<OptimizeResult> {
  const images: ImageOptimization[] = []
  const svgs: SvgOptimizationData[] = []
  const changes: CodeChange[] = []
  const artifacts = new Map<string, Artifact>()
  for (const asset of options.rasters) {
    options.signal?.throwIfAborted()
    const { image, change, artifacts: produced } = await optimizeRaster(asset, options)
    images.push(image)
    if (change) changes.push(change)
    for (const artifact of produced) artifacts.set(artifact.sha256, artifact)
    options.log?.(
      `assets: ${asset.path} ${image.error ?? (image.best ? `best ${image.best.format} −${image.best.savingPercent}%` : 'no smaller variant')}`,
    )
  }
  for (const asset of options.svgs) {
    options.signal?.throwIfAborted()
    const { svg, change } = await optimizeVector(asset, options)
    svgs.push(svg)
    if (change) changes.push(change)
  }
  return { images, svgs, changes, artifacts: [...artifacts.values()] }
}
