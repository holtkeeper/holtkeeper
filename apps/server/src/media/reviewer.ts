import type { ReviewComment } from '@holtkeeper/forge'
import type { EncodedVariant, SnippetFramework, SnippetVariant } from '@holtkeeper/media'
import type { MediaFile, MediaReviewInput, MediaReviewer, MediaUsage } from '@holtkeeper/review'

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
  options: Required<Omit<MediaReviewerOptions, 'publicUrl'>>,
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
  const plan = media.planVariants(info)
  const { variants } = await media.encodeVariants(bytes, plan.specs, { info })
  const original = { bytes: bytes.byteLength, width: info.width, format: info.format }
  const summary = media.savingsSummary(original, variants)
  const table = media.savingsMarkdown(summary, `${file.path} · ${info.width}×${info.height}`)
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

function reviewSvg(
  media: Media,
  file: MediaFile,
  options: Required<Omit<MediaReviewerOptions, 'publicUrl'>>,
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
 * (original against AVIF/WebP/re-encoded, typical transfer at 375/768/1440 CSS px), a `<picture>`
 * suggestion on added usage lines, a whole-file svgo suggestion for added SVGs that are short
 * enough, and links to the media panel.
 */
export function createMediaReviewer(options: MediaReviewerOptions = {}): MediaReviewer {
  const limits = {
    maxBytes: options.maxBytes ?? 25 * 1024 * 1024,
    maxPixels: options.maxPixels ?? 50_000_000,
    minSaving: options.minSaving ?? 2048,
    maxSuggestionLines: options.maxSuggestionLines ?? 200,
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
          : await reviewRaster(media, file, usages, limits)
        comments.push(...result.comments)
        if (!result.summary) continue
        const link = options.publicUrl
          ? `\n\n[Variants and snippets for \`${name}\`](${panelLink(options.publicUrl, input, file.path)})`
          : ''
        parts.push(`${result.summary}${link}`)
      }
      return { comments, ...(parts.length ? { summary: parts.join('\n\n') } : {}) }
    },
  }
}
