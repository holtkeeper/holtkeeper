/** Options of a variants request, passed to the engine as given. */
export interface MediaVariantOptions {
  /** e.g. `avif`, `webp`, `jpeg`, `png`. */
  formats?: string[]
  widths?: number[]
  densities?: number[]
  /** 1–100. */
  quality?: number
  /** Engine preset name, e.g. `hero` or `thumbnail`. */
  preset?: string
}

/** Facts about the original image. */
export interface MediaImageInfo {
  width: number
  height: number
  /** e.g. `png`, `jpeg`, `svg`. */
  format: string
  bytes: number
}

/** One encoded variant. */
interface MediaVariantOutput {
  format: string
  width: number
  height: number
  quality: number
  data: Uint8Array
  contentType: string
  /** Repository path the engine suggests; default `<dir>/<name>-<width>w.<format>`. */
  path?: string
}

export interface MediaSvgOutput {
  data: string
  before: number
  after: number
  /** Bytes saved per optimization step. */
  breakdown: Record<string, number>
  width?: number
  height?: number
}

/** A variant as markup snippets reference it. */
interface MediaSnippetVariant {
  path: string
  format: string
  width: number
  height: number
}

/**
 * The image engine the media routes use. The server talks only to this interface; the adapter in
 * `adapter.ts` maps it to `@holtkeeper/media`, and tests inject fakes.
 */
export interface MediaEngine {
  /**
   * Decodes `data` and encodes the requested variants. Must reject images above `maxPixels`
   * before decoding them fully.
   */
  variants(input: {
    data: Uint8Array
    file: string
    options: MediaVariantOptions
    maxPixels: number
  }): Promise<{ original: MediaImageInfo; variants: MediaVariantOutput[] }>
  optimizeSvg(input: { svg: string; file: string }): Promise<MediaSvgOutput>
  /** Markup per framework (`html`, `react`, `vue`, ...) for using the variants. */
  snippets(input: {
    file: string
    original: MediaImageInfo
    variants: MediaSnippetVariant[]
  }): Promise<Record<string, string>>
}
