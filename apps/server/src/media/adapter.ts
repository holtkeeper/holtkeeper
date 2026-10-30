import type * as Media from '@holtkeeper/media'
import type { OutputFormat, PlanOptions, SnippetVariant } from '@holtkeeper/media'

import type { MediaEngine, MediaImageInfo, MediaSvgOutput, MediaVariantOptions } from './engine.ts'

const contentTypes: Record<string, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

/** The MIME type of an image format name; `application/octet-stream` for unknown ones. */
export const imageContentType = (format: string) =>
  contentTypes[format.toLowerCase()] ?? 'application/octet-stream'

let loaded: Promise<typeof Media> | undefined

/** `@holtkeeper/media`, imported on first use so sharp loads only when images are processed. */
export const loadMedia = () => (loaded ??= import('@holtkeeper/media'))

const efforts = { fast: 'fast', default: 'default', max: 'max' } as const

/** Plan options of a request: unknown formats are dropped, densities make a texture-style ladder. */
export function planOptionsOf(
  options: MediaVariantOptions,
  formats: readonly OutputFormat[],
): PlanOptions {
  const wanted = options.formats?.map((format) => (format === 'jpg' ? 'jpeg' : format))
  const chosen = wanted && formats.filter((format) => wanted.includes(format))
  const effort = options.preset
    ? Object.entries(efforts).find(([key]) => key === options.preset)?.[1]
    : undefined
  return {
    ...(chosen?.length ? { formats: chosen } : {}),
    ...(options.widths?.length ? { widths: options.widths } : {}),
    ...(options.densities?.length
      ? { usage: 'texture' as const, densities: options.densities }
      : {}),
    ...(options.quality ? { quality: options.quality } : {}),
    ...(effort ? { effort } : {}),
  }
}

/** Width and height of an SVG from its root `width`/`height`, else its `viewBox`. */
function svgSize(tags: ReturnType<typeof Media.scanTags>): {
  width?: number
  height?: number
} {
  const root = tags.find((tag) => tag.name === 'svg')
  const width = Number.parseFloat(root?.attributes.get('width') ?? '')
  const height = Number.parseFloat(root?.attributes.get('height') ?? '')
  if (Number.isFinite(width) && Number.isFinite(height)) return { width, height }
  const box = root?.attributes
    .get('viewBox')
    ?.split(/[\s,]+/)
    .map(Number)
  return box?.[2] && box[3] ? { width: box[2], height: box[3] } : {}
}

function plainImg(file: string, original: MediaImageInfo, syntax: 'html' | 'jsx' | 'vue') {
  const size = (value: number) => (syntax === 'jsx' ? `{${value}}` : `"${value}"`)
  const dims = original.width
    ? ` width=${size(original.width)} height=${size(original.height)}`
    : ''
  return `<img src="${file}"${dims} alt="" loading="lazy" decoding="async"${syntax === 'html' ? '>' : ' />'}`
}

const sum = (counts: Record<string, number>) =>
  Object.values(counts).reduce((total, count) => total + count, 0)

/**
 * The real engine, `@holtkeeper/media` (sharp, svgo), loaded on first use so the server starts
 * without native image libraries until someone requests variants.
 */
export function mediaEngine(): MediaEngine {
  return {
    async variants({ data, file, options, maxPixels }) {
      const media = await loadMedia()
      const sharp = await media.requireSharp()
      const meta = await sharp(data).metadata()
      if (meta.width * (meta.pageHeight ?? meta.height) > maxPixels)
        throw new Error(`more than ${maxPixels} pixels`)
      const info = await media.probeImage(data)
      const plan = media.planVariants(info, planOptionsOf(options, media.outputFormats))
      const { variants, failures } = await media.encodeVariants(data, plan.specs, { info })
      if (!variants.length && failures[0]) throw new Error(failures[0].error)
      return {
        original: {
          width: info.width,
          height: info.height,
          format: info.format,
          bytes: data.byteLength,
        },
        variants: variants.map((variant) => ({
          format: variant.format,
          width: variant.width,
          height: variant.height,
          quality: variant.quality,
          data: variant.data,
          contentType: imageContentType(variant.format),
          path: media.variantFile(file, { ...variant.spec, replacesOriginal: false }),
        })),
      }
    },
    async optimizeSvg({ svg }): Promise<MediaSvgOutput> {
      const media = await loadMedia()
      const result = media.optimizeSvg(svg, { preset: 'safe' })
      const { breakdown } = result
      return {
        data: result.text,
        before: result.bytes.before,
        after: result.bytes.after,
        breakdown: {
          gzipBefore: result.gzip.before,
          gzipAfter: result.gzip.after,
          metadata: breakdown.metadata,
          comments: breakdown.comments,
          elements: sum(breakdown.removedElements),
          attributes: sum(breakdown.removedAttributes),
          pathDigitsBefore: breakdown.paths.before.digits,
          pathDigitsAfter: breakdown.paths.after.digits,
          idsMinified: breakdown.ids.minified,
        },
        ...svgSize(media.scanTags(svg)),
      }
    },
    async snippets({ file, original, variants }) {
      const media = await loadMedia()
      if (!variants.length) {
        return {
          html: plainImg(file, original, 'html'),
          react: plainImg(file, original, 'jsx'),
          vue: plainImg(file, original, 'vue'),
          css: `background-image: url("${file}");`,
        }
      }
      const usable: SnippetVariant[] = variants.flatMap((variant) => {
        const format = media.formatOfFile(`x.${variant.format}`)
        return format ? [{ format, width: variant.width, url: variant.path }] : []
      })
      return Object.fromEntries(
        media.snippetFrameworks.map((framework) => [
          framework,
          media.pictureSnippets({
            file,
            variants: usable,
            framework,
            ...(original.width ? { width: original.width, height: original.height } : {}),
          }).code,
        ]),
      )
    },
  }
}
