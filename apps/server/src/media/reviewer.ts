import type { ReviewComment } from '@holtkeeper/forge'
import type {
  EncodedVariant,
  SnippetFramework,
  SnippetVariant,
  VariantCache,
} from '@holtkeeper/media'
import type {
  MediaCodeFile,
  MediaFile,
  MediaReviewInput,
  MediaReviewer,
  MediaUsage,
} from '@holtkeeper/review'

import { loadMedia } from './adapter.ts'

export interface MediaReviewerOptions {
  /** Server origin for links to the media panel; without it no links are written. */
  publicUrl?: string
  /** Rasters larger than this are only mentioned. Default 25 MB. */
  maxBytes?: number
  /** Images decoded above this many pixels are only mentioned. Default 50 megapixels. */
  maxPixels?: number
  /** A format must save at least this many bytes to be suggested. Default 2 kB. */
  minSaving?: number
  /** Added SVGs up to this many lines get a whole-file suggestion. Default 200. */
  maxSuggestionLines?: number
  /** Encoded variants kept between reviews (e.g. `artifactCache` on S3), so re-pushes do not encode again. */
  cache?: VariantCache
  /** Encode AVIF and ask for an AVIF sibling next to WebP. Default false. */
  avif?: boolean
}

type Limits = Required<Omit<MediaReviewerOptions, 'publicUrl' | 'cache'>> & {
  cache?: VariantCache
}

/** Images wider than this should come with smaller sizes. */
const HIGH_RES_WIDTH = 1280

const legacyFormats = new Set(['png', 'jpeg', 'jpg', 'gif'])

const formatNames: Record<string, string> = { avif: 'AVIF', webp: 'WebP' }

const SIZE_SUFFIX = /(?:-\d+w?|@\d+(?:\.\d+)?x)\.[^./]+$/

const stemOf = (path: string) => path.replace(/(?:-\d+w?|@\d+(?:\.\d+)?x)?\.[^./]+$/, '')

/** What the merge request ships next to `path`: other formats and sized variants of the same image. */
function siblingsOf(path: string, paths: readonly string[]) {
  const stem = stemOf(path)
  const siblings = paths.filter((other) => other !== path && stemOf(other) === stem)
  return {
    formats: new Set(
      siblings.map((other) => other.slice(other.lastIndexOf('.') + 1).toLowerCase()),
    ),
    sized: siblings.some((other) => SIZE_SUFFIX.test(other)),
  }
}

/** Delivery notes for a raster: missing WebP (and AVIF) siblings, one large resolution only. */
function deliveryNotes(
  file: MediaFile,
  width: number,
  paths: readonly string[],
  avif: boolean,
): string[] {
  const format = file.path.slice(file.path.lastIndexOf('.') + 1).toLowerCase()
  const siblings = siblingsOf(file.path, paths)
  const notes: string[] = []
  const missing = (avif ? ['avif', 'webp'] : ['webp']).filter(
    (other) => !siblings.formats.has(other),
  )
  if (legacyFormats.has(format) && missing.length)
    notes.push(`no ${missing.map((other) => formatNames[other]).join('/')} version comes with it`)
  if (width > HIGH_RES_WIDTH && !siblings.sized && !SIZE_SUFFIX.test(file.path))
    notes.push(`only one resolution (${width} px wide): phones download the full-size file`)
  return notes
}

type Media = Awaited<ReturnType<typeof loadMedia>>

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const frameworkOf = (path: string): SnippetFramework =>
  /\.(?:jsx|tsx)$/.test(path) ? 'react' : path.endsWith('.vue') ? 'vue' : 'html'

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Link to the media panel for a file of the merge request's head. */
export function panelLink(publicUrl: string, input: MediaReviewInput, file: string): string {
  const query = new URLSearchParams({
    repo: `${input.repo.forge}:${input.repo.path}`,
    file,
    ref: input.refs.headSha,
  })
  return `${publicUrl.replace(/\/+$/, '')}/media?${query.toString()}`
}

/** Lines of a text, not counting the empty string after a final newline. */
const lineCount = (text: string) => text.replace(/\n$/, '').split('\n').length

/** Per format, the variants worth shipping: its largest one saves at least `minSaving`. */
function worthShipping(original: number, variants: readonly EncodedVariant[], minSaving: number) {
  return variants.filter((variant) => {
    const largest = variants
      .filter((other) => other.format === variant.format)
      .toSorted((a, b) => b.width - a.width)[0]
    return largest !== undefined && original - largest.bytes >= minSaving
  })
}

/** `<img>` of a usage line pointing at `name`, with its src as written. */
function imgOf(line: string, name: string): { tag: string; src: string } | undefined {
  const pattern = new RegExp(`<img\\b[^>]*?\\bsrc=(["'])([^"']*${escapeRegExp(name)})\\1[^>]*>`)
  const match = line.match(pattern)
  if (!match || /\bsrcset=|\bsrcSet=/.test(match[0])) return undefined
  return { tag: match[0], src: match[2] ?? '' }
}

async function reviewRaster(
  media: Media,
  file: MediaFile,
  usages: readonly MediaUsage[],
  options: Limits,
  paths: readonly string[],
): Promise<{ comments: ReviewComment[]; summary: string }> {
  const bytes = file.bytes
  if (!bytes) return { comments: [], summary: `\`${file.path}\`: not readable from the forge.` }
  if (bytes.byteLength > options.maxBytes)
    return { comments: [], summary: `\`${file.path}\`: too large to analyze here.` }
  let info: Awaited<ReturnType<Media['probeImage']>>
  try {
    const sharp = await media.requireSharp()
    const meta = await sharp(bytes).metadata()
    if (meta.width * (meta.pageHeight ?? meta.height) > options.maxPixels)
      return { comments: [], summary: `\`${file.path}\`: too many pixels to analyze here.` }
    info = await media.probeImage(bytes)
  } catch (error) {
    return {
      comments: [],
      summary: `\`${file.path}\`: cannot decode (${error instanceof Error ? error.message : String(error)}).`,
    }
  }
  const plan = media.planVariants(info, {
    formats: [...(options.avif ? (['avif'] as const) : []), 'webp', media.originalOutput(info)],
  })
  const { variants } = await media.encodeVariants(bytes, plan.specs, {
    info,
    ...(options.cache ? { cache: options.cache } : {}),
  })
  const original = { bytes: bytes.byteLength, width: info.width, format: info.format }
  const summary = media.savingsSummary(original, variants)
  const notes = info.animated ? [] : deliveryNotes(file, info.width, paths, options.avif)
  const table = [
    media.savingsMarkdown(summary, `${file.path} · ${info.width}×${info.height}`),
    ...(notes.length ? [`\`${file.path}\`: ${notes.join('; ')}.`] : []),
  ].join('\n\n')
  const shipped = worthShipping(bytes.byteLength, variants, options.minSaving)
  const best = summary.best
  const comments: ReviewComment[] = []
  if (best && best.saving >= options.minSaving && shipped.length) {
    const name = nameOf(file.path)
    for (const usage of usages) {
      const img = imgOf(usage.text, name)
      if (!img) continue
      const snippetVariants: SnippetVariant[] = shipped.map((variant) => ({
        format: variant.format,
        width: variant.width,
        ...(variant.spec.replacesOriginal ? { replacesOriginal: true } : {}),
      }))
      const indent = usage.text.match(/^\s*/)?.[0] ?? ''
      const alt = img.tag.match(/\balt=(["'])(.*?)\1/)?.[2]
      const snippet = media.pictureSnippets({
        file: img.src,
        variants: snippetVariants,
        framework: frameworkOf(usage.path),
        width: info.width,
        height: info.height,
        indent,
        ...(alt === undefined ? {} : { alt }),
      })
      comments.push({
        path: usage.path,
        line: usage.line,
        body: [
          `Serve ${name} as ${best.format.toUpperCase()} with responsive <picture>`,
          '',
          `The best full-size variant saves ${best.savingPercent}% (${best.bytes} of ${bytes.byteLength} bytes); a phone at 375 px downloads ${summary.viewports[0]?.best?.bytes ?? best.bytes} bytes. Generate the variant files from the media panel or the assets analysis before applying this.`,
        ].join('\n'),
        suggestion: { replacement: usage.text.replace(img.tag, snippet.code) },
      })
    }
  }
  return { comments, summary: table }
}

/**
 * Comments on inline SVGs whose lines the diff adds entirely, with a suggestion replacing exactly
 * those lines; fragments touching untouched lines are only summarized.
 */
function reviewCode(
  media: Media,
  file: MediaCodeFile,
): { comments: ReviewComment[]; summary?: string } {
  const syntax = media.inlineSyntaxOf(file.path)
  if (file.text === undefined || !syntax) return { comments: [] }
  const added = new Set(file.addedLines)
  const lines = file.text.split('\n')
  const touched = media
    .optimizeInlineSvgs(file.text, { syntax })
    .filter((fragment) =>
      Array.from(
        { length: fragment.endLine - fragment.line + 1 },
        (_, i) => fragment.line + i,
      ).some((line) => added.has(line)),
    )
  if (!touched.length) return { comments: [] }
  const comments: ReviewComment[] = []
  for (const fragment of touched) {
    const range = Array.from(
      { length: fragment.endLine - fragment.line + 1 },
      (_, i) => fragment.line + i,
    )
    if (!range.every((line) => added.has(line))) continue
    const original = lines.slice(fragment.line - 1, fragment.endLine).join('\n')
    const replacement = original.replace(fragment.oldText, fragment.newText)
    if (replacement === original) continue
    const saving = fragment.bytes.before - fragment.bytes.after
    const percent = Math.round((saving / fragment.bytes.before) * 1000) / 10
    comments.push({
      path: file.path,
      line: fragment.endLine,
      ...(fragment.endLine > fragment.line ? { startLine: fragment.line } : {}),
      body: [
        fragment.kind === 'svg'
          ? 'Optimize this inline SVG with svgo (safe preset)'
          : 'Shorten the path data of this inline SVG',
        '',
        fragment.kind === 'svg'
          ? `Saves ${saving} bytes (${percent}%): editor metadata, comments and excess decimals go; ids, classes and styles stay.`
          : `Saves ${saving} bytes (${percent}%): path digits ${fragment.digits.before} → ${fragment.digits.after} at 3 decimals; nothing but the \`d\` values changes.`,
      ].join('\n'),
      suggestion: { replacement },
    })
  }
  const before = touched.reduce((sum, fragment) => sum + fragment.bytes.before, 0)
  const after = touched.reduce((sum, fragment) => sum + fragment.bytes.after, 0)
  return {
    comments,
    summary: `\`${file.path}\`: ${touched.length} inline SVG${touched.length === 1 ? '' : 's'}, ${before} → ${after} bytes after svgo.`,
  }
}

function reviewSvg(
  media: Media,
  file: MediaFile,
  options: Limits,
): { comments: ReviewComment[]; summary?: string } {
  const text = file.text
  if (text === undefined)
    return { comments: [], summary: `\`${file.path}\`: not readable from the forge.` }
  let result: ReturnType<Media['optimizeSvg']>
  try {
    result = media.optimizeSvg(text, { preset: 'safe' })
  } catch (error) {
    return {
      comments: [],
      summary: `\`${file.path}\`: svgo cannot parse it (${error instanceof Error ? error.message : String(error)}).`,
    }
  }
  const saving = result.bytes.before - result.bytes.after
  if (saving < Math.max(64, result.bytes.before * 0.05)) return { comments: [] }
  const percent = Math.round((saving / result.bytes.before) * 1000) / 10
  const { paths } = result.breakdown
  const line = `\`${file.path}\`: ${result.bytes.before} → ${result.bytes.after} bytes (−${percent}%), gzip ${result.gzip.before} → ${result.gzip.after}; path digits ${paths.before.digits} → ${paths.after.digits}`
  const lines = lineCount(text)
  if (file.status !== 'added' || lines > options.maxSuggestionLines)
    return { comments: [], summary: line }
  return {
    comments: [
      {
        path: file.path,
        line: lines,
        ...(lines > 1 ? { startLine: 1 } : {}),
        body: [
          `Optimize ${nameOf(file.path)} with svgo (safe preset)`,
          '',
          `Saves ${saving} bytes (${percent}%): editor metadata, comments and excess decimals are removed; IDs, classes and styles are kept.`,
        ].join('\n'),
        suggestion: { replacement: result.text },
      },
    ],
    summary: line,
  }
}

/**
 * Reviews images of a merge request with `@holtkeeper/media`: a savings table per raster image
 * (original against WebP/re-encoded, plus AVIF with `avif`, typical transfer at 375/768/1440 CSS px)
 * with a note when no WebP (or AVIF) or smaller sizes come along, a `<picture>` suggestion on added usage lines, a
 * whole-file svgo suggestion for added SVGs that are short enough, suggestions for bloated inline
 * SVGs on added code lines, and links to the media panel.
 */
export function createMediaReviewer(options: MediaReviewerOptions = {}): MediaReviewer {
  const limits: Limits = {
    maxBytes: options.maxBytes ?? 25 * 1024 * 1024,
    maxPixels: options.maxPixels ?? 50_000_000,
    minSaving: options.minSaving ?? 2048,
    maxSuggestionLines: options.maxSuggestionLines ?? 200,
    avif: options.avif ?? false,
    ...(options.cache ? { cache: options.cache } : {}),
  }
  return {
    async review(input) {
      const media = await loadMedia()
      const comments: ReviewComment[] = []
      const parts: string[] = []
      for (const file of input.files) {
        const name = nameOf(file.path)
        const usages = input.usages.filter((usage) => usage.text.includes(name))
        const result = /\.svg$/i.test(file.path)
          ? reviewSvg(media, file, limits)
          : await reviewRaster(media, file, usages, limits, input.paths)
        comments.push(...result.comments)
        if (!result.summary) continue
        const link = options.publicUrl
          ? `\n\n[Variants and snippets for \`${name}\`](${panelLink(options.publicUrl, input, file.path)})`
          : ''
        parts.push(`${result.summary}${link}`)
      }
      for (const file of input.code) {
        const result = reviewCode(media, file)
        comments.push(...result.comments)
        if (result.summary) parts.push(result.summary)
      }
      return { comments, ...(parts.length ? { summary: parts.join('\n\n') } : {}) }
    },
  }
}
