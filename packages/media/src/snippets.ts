import type { OutputFormat } from './types.ts'

/** Markup or code flavors `pictureSnippets` writes. */
export const snippetFrameworks = [
  'html',
  'react',
  'vue',
  'css',
  'next',
  'nuxt',
  'vite',
  'pixi',
  'phaser',
  'three',
] as const

export type SnippetFramework = (typeof snippetFrameworks)[number]

/** The part of a variant snippets need. */
export interface SnippetVariant {
  format: OutputFormat
  width: number
  density?: number
  /** Written over the original file, so it is referenced by the original name. */
  replacesOriginal?: boolean
  /** Explicit URL of the variant; overrides the naming scheme. */
  url?: string
}

/** File name templates; placeholders `{name}` (stem), `{width}`, `{density}`, `{ext}`. */
export interface NamingScheme {
  /** Default `{name}-{width}w.{ext}`. */
  width?: string
  /** Default `{name}@{density}x.{ext}`. */
  density?: string
}

export interface SnippetOptions {
  /** The original image as the markup references it, e.g. `/images/hero.png` or `./hero.png`. */
  file: string
  variants: readonly SnippetVariant[]
  framework: SnippetFramework
  alt?: string
  /** `sizes` for width descriptors; default `100vw`. */
  sizes?: string
  /** Intrinsic size written on `<img>` to reserve layout space. */
  width?: number
  height?: number
  naming?: NamingScheme
  /** Extra attributes for `<img>`, already in the framework's syntax (e.g. `className="hero"`). */
  attributes?: string
  /** Prefix for every line after the first, to fit the surrounding code. */
  indent?: string
  /** Loader key for game engines; default the file stem. */
  key?: string
}

export interface Snippet {
  framework: SnippetFramework
  language: 'html' | 'tsx' | 'vue' | 'css' | 'ts'
  code: string
  /** What the reader should know before pasting it. */
  notes: string[]
}

const mime: Record<OutputFormat, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}

const order: OutputFormat[] = ['avif', 'webp', 'png', 'jpeg', 'gif']

const extensionOf = (file: string) => {
  const name = file.slice(file.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The output format matching a file extension (`jpg` → `jpeg`), if any. */
export function formatOfFile(file: string): OutputFormat | undefined {
  const extension = extensionOf(file)
  if (extension === 'jpg' || extension === 'jpeg') return 'jpeg'
  return order.find((format) => format === extension)
}

/**
 * Where a variant of `file` lives, next to it, by the naming scheme. Variants that replace the
 * original keep its name; a variant in the original's format keeps its extension (`.jpg`); an
 * explicit `url` wins.
 */
export function variantFile(
  file: string,
  variant: SnippetVariant,
  naming: NamingScheme = {},
): string {
  if (variant.url) return variant.url
  if (variant.replacesOriginal) return file
  return fileName(
    file,
    variant.format,
    String(variant.width),
    variant.density === undefined ? undefined : String(variant.density),
    naming,
  )
}

function fileName(
  file: string,
  format: OutputFormat,
  width: string,
  density: string | undefined,
  naming: NamingScheme = {},
): string {
  const slash = file.lastIndexOf('/')
  const ext = formatOfFile(file) === format ? extensionOf(file) : format
  const template =
    density === undefined
      ? (naming.width ?? '{name}-{width}w.{ext}')
      : (naming.density ?? '{name}@{density}x.{ext}')
  return (
    file.slice(0, slash + 1) +
    template
      .replaceAll('{name}', stemOf(file))
      .replaceAll('{width}', width)
      .replaceAll('{density}', density ?? '1')
      .replaceAll('{ext}', ext)
  )
}

interface Group {
  format: OutputFormat
  variants: SnippetVariant[]
}

function groups(variants: readonly SnippetVariant[]): Group[] {
  return order
    .map((format) => ({
      format,
      variants: variants
        .filter((variant) => variant.format === format)
        .toSorted((a, b) => (a.density ?? a.width) - (b.density ?? b.width)),
    }))
    .filter((group) => group.variants.length)
}

const usesDensity = (variants: readonly SnippetVariant[]) =>
  variants.length > 0 && variants.every((variant) => variant.density !== undefined)

const srcset = (file: string, group: Group, naming?: NamingScheme) =>
  group.variants
    .map(
      (variant) =>
        `${variantFile(file, variant, naming)} ${variant.density === undefined ? `${variant.width}w` : `${variant.density}x`}`,
    )
    .join(', ')

const escapeAttribute = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')

const stemOf = (file: string) => {
  const name = file.slice(file.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot === -1 ? name : name.slice(0, dot)
}

const indented = (lines: string[], indent = '') =>
  lines.map((line, index) => (index === 0 ? line : indent + line)).join('\n')

function pictureMarkup(options: SnippetOptions, syntax: 'html' | 'jsx' | 'vue'): string[] {
  const jsx = syntax === 'jsx'
  const { file, naming } = options
  const all = groups(options.variants)
  const originalFormat = formatOfFile(file)
  const fallback = all.find((group) => group.format === originalFormat)
  const sources = all.filter((group) => group !== fallback)
  const density = usesDensity(options.variants)
  const sizes = density ? undefined : (options.sizes ?? '100vw')
  const set = jsx ? 'srcSet' : 'srcset'
  const close = syntax === 'html' ? '>' : ' />'
  const number = (value: number) => (jsx ? `{${value}}` : `"${value}"`)
  const lines = ['<picture>']
  for (const group of sources) {
    lines.push(
      `  <source type="${mime[group.format]}" ${set}="${srcset(file, group, naming)}"${sizes ? ` sizes="${sizes}"` : ''}${close}`,
    )
  }
  const largest = fallback?.variants.at(-1)
  const src = largest ? variantFile(file, largest, naming) : file
  const img = [
    `src="${src}"`,
    ...(fallback && fallback.variants.length > 1
      ? [`${set}="${srcset(file, fallback, naming)}"`, ...(sizes ? [`sizes="${sizes}"`] : [])]
      : []),
    ...(options.width ? [`width=${number(options.width)}`] : []),
    ...(options.height ? [`height=${number(options.height)}`] : []),
    `alt="${escapeAttribute(options.alt ?? '')}"`,
    ...(options.attributes?.trim() ? [options.attributes.trim()] : []),
    'loading="lazy"',
    'decoding="async"',
  ]
  lines.push(`  <img ${img.join(' ')}${close}`, '</picture>')
  return lines
}

/** The CSS `image-set()` value of the variants, ending with the original as the last candidate. */
export function imageSetValue(
  options: Pick<SnippetOptions, 'file' | 'variants' | 'naming'>,
): string {
  const { file, naming } = options
  const density = usesDensity(options.variants)
  const entries = groups(options.variants).flatMap((group) => {
    const chosen = density ? group.variants : group.variants.slice(-1)
    return chosen.map(
      (variant) =>
        `url("${variantFile(file, variant, naming)}") type("${mime[group.format]}")${density ? ` ${variant.density}x` : ''}`,
    )
  })
  if (!groups(options.variants).some((group) => group.format === formatOfFile(file))) {
    const format = formatOfFile(file)
    if (format) entries.push(`url("${file}") type("${mime[format]}")${density ? ' 1x' : ''}`)
  }
  return `image-set(${entries.join(', ')})`
}

const AVIF_1PX =
  'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAAB8AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAnbWRhdBIACgc4AAaQENBpMhIZQmMEw88880EgAJBAyRxhQr4='
const WEBP_1PX = 'UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw=='

const gpuNote =
  'GPU memory, not download size, limits large textures: KTX2 with Basis Universal (toktx, basisu) stays compressed on the GPU — three KTX2Loader, Pixi KTX2 support, Phaser compressed textures (`load.texture`).'

function gameSnippet(options: SnippetOptions): Snippet {
  const { file, naming } = options
  const key = options.key ?? stemOf(file)
  const all = groups(options.variants)
  const formats = all.map((group) => group.format)
  const densities = [
    ...new Set(
      options.variants.flatMap((variant) =>
        variant.density === undefined ? [] : [variant.density],
      ),
    ),
  ].toSorted((a, b) => a - b)
  const top = (format: OutputFormat) => {
    const group = all.find((entry) => entry.format === format)
    const variant = group?.variants.at(-1)
    return variant ? variantFile(file, variant, naming) : file
  }
  const pattern = (format: OutputFormat, density: string) => {
    const sample = all.find((group) => group.format === format)?.variants[0]
    return sample ? fileName(file, format, String(sample.width), density, naming) : file
  }
  const fallback =
    formats.find((format) => format !== 'avif' && format !== 'webp') ?? formatOfFile(file) ?? 'png'
  const fallbackFile = formats.includes(fallback) ? top(fallback) : file
  const notes = [gpuNote]
  if (options.framework === 'pixi') {
    const code = densities.length
      ? `const texture = await Assets.load('${pattern(formats[0] ?? fallback, `{${densities.join(',')}}`).replace(/\.[^./]+$/, `.{${formats.map((format) => (format === formatOfFile(file) ? extensionOf(file) : format)).join(',')}}`)}')`
      : `const texture = await Assets.load({ alias: '${key}', src: [${formats.map((format) => `'${top(format)}'`).join(', ')}] })`
    notes.unshift(
      'Pixi Assets picks the first format the browser decodes and the resolution closest to `resolution` from the `{a,b}` pattern.',
    )
    return {
      framework: 'pixi',
      language: 'ts',
      code: indented([`import { Assets } from 'pixi.js'`, '', code], options.indent),
      notes,
    }
  }
  const scale = densities.length
    ? [
        `const density = ${JSON.stringify(densities)}.find((value) => value >= window.devicePixelRatio) ?? ${densities.at(-1)}`,
      ]
    : []
  const url = (format: OutputFormat | 'fallback') =>
    densities.length
      ? `\`${pattern(format === 'fallback' ? fallback : format, '${density}')}\``
      : `'${format === 'fallback' ? fallbackFile : top(format)}'`
  const webp = formats.includes('webp')
  if (options.framework === 'phaser') {
    notes.unshift(
      'Phaser detects WebP (`device.features.webp`) but not AVIF, so AVIF variants are not used here.',
    )
    return {
      framework: 'phaser',
      language: 'ts',
      code: indented(
        [
          ...scale,
          webp
            ? `const url = this.sys.game.device.features.webp ? ${url('webp')} : ${url('fallback')}`
            : `const url = ${url('fallback')}`,
          `this.load.image('${key}', url)`,
        ],
        options.indent,
      ),
      notes,
    }
  }
  const avif = formats.includes('avif')
  return {
    framework: 'three',
    language: 'ts',
    code: indented(
      [
        `import { TextureLoader } from 'three'`,
        '',
        'const decodes = (type: string, data: string) =>',
        '  createImageBitmap(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type })).then(',
        '    () => true,',
        '    () => false,',
        '  )',
        ...scale,
        'const url =',
        ...(avif
          ? [`  (await decodes('image/avif', '${AVIF_1PX}'))`, `    ? ${url('avif')}`, '    :']
          : []),
        ...(webp
          ? [
              `  (await decodes('image/webp', '${WEBP_1PX}'))`,
              `    ? ${url('webp')}`,
              `    : ${url('fallback')}`,
            ]
          : [`  ${url('fallback')}`]),
        `const texture = await new TextureLoader().loadAsync(url)`,
      ],
      options.indent,
    ),
    notes,
  }
}

/**
 * Code that uses the generated variants: `<picture>` for HTML, React and Vue, `image-set()` for
 * CSS backgrounds, framework components (Next.js, Nuxt, Vite imagetools) and texture loading for
 * Pixi, Phaser and three with a format fallback and resolution variants. Paths follow
 * `variantFile` with the given naming scheme.
 */
export function pictureSnippets(options: SnippetOptions): Snippet {
  const { framework, file } = options
  const size = [
    ...(options.width ? [`width={${options.width}}`] : []),
    ...(options.height ? [`height={${options.height}}`] : []),
  ]
  switch (framework) {
    case 'html':
      return {
        framework,
        language: 'html',
        code: indented(pictureMarkup(options, 'html'), options.indent),
        notes: [],
      }
    case 'react':
      return {
        framework,
        language: 'tsx',
        code: indented(pictureMarkup(options, 'jsx'), options.indent),
        notes: [],
      }
    case 'vue':
      return {
        framework,
        language: 'vue',
        code: indented(pictureMarkup(options, 'vue'), options.indent),
        notes: [],
      }
    case 'css': {
      return {
        framework,
        language: 'css',
        code: indented(
          [`background-image: url("${file}");`, `background-image: ${imageSetValue(options)};`],
          options.indent,
        ),
        notes: [
          'The plain url() line is the fallback for browsers without image-set() type() support.',
        ],
      }
    }
    case 'next':
      return {
        framework,
        language: 'tsx',
        code: indented(
          [
            `import Image from 'next/image'`,
            '',
            `<Image src="${file}" alt="${escapeAttribute(options.alt ?? '')}" ${size.join(' ')}${size.length ? ' ' : ''}sizes="${options.sizes ?? '100vw'}" />`,
          ],
          options.indent,
        ),
        notes: [
          "next/image encodes AVIF/WebP on request with `images: { formats: ['image/avif', 'image/webp'] }` in next.config, so the generated files are not needed; with `output: 'export'` there is no optimizer — use the React <picture> snippet.",
        ],
      }
    case 'nuxt': {
      const attrs = [
        ...(options.width ? [`width="${options.width}"`] : []),
        ...(options.height ? [`height="${options.height}"`] : []),
      ]
      return {
        framework,
        language: 'vue',
        code: indented(
          [
            `<NuxtPicture src="${file}" format="avif,webp" alt="${escapeAttribute(options.alt ?? '')}" ${attrs.join(' ')}${attrs.length ? ' ' : ''}sizes="${options.sizes ?? '100vw'}" loading="lazy" />`,
          ],
          options.indent,
        ),
        notes: [
          '@nuxt/image produces the formats through its provider (IPX by default, source under public/); the generated files are only needed without it.',
        ],
      }
    }
    case 'vite': {
      const widths = [
        ...new Set(
          options.variants
            .filter((variant) => variant.density === undefined)
            .map((variant) => variant.width),
        ),
      ].toSorted((a, b) => a - b)
      const list = (widths.length ? widths : [options.width ?? 1280]).join(';')
      const largest = widths.at(-1) ?? options.width ?? 1280
      const stem = stemOf(file).replaceAll(/\W/g, '_')
      const formats = groups(options.variants)
        .map((group) => group.format)
        .filter((format) => format === 'avif' || format === 'webp')
      return {
        framework,
        language: 'tsx',
        code: indented(
          [
            ...formats.map(
              (format) =>
                `import ${stem}${format[0]?.toUpperCase()}${format.slice(1)} from '${file}?w=${list}&format=${format}&as=srcset'`,
            ),
            `import ${stem} from '${file}?w=${largest}'`,
            '',
            '<picture>',
            ...formats.map(
              (format) =>
                `  <source type="${mime[format]}" srcSet={${stem}${format[0]?.toUpperCase()}${format.slice(1)}} sizes="${options.sizes ?? '100vw'}" />`,
            ),
            `  <img src={${stem}} ${size.join(' ')}${size.length ? ' ' : ''}alt="${escapeAttribute(options.alt ?? '')}" loading="lazy" decoding="async" />`,
            '</picture>',
          ],
          options.indent,
        ),
        notes: [
          'Needs vite-imagetools; it encodes at build time, so the generated files do not have to be committed.',
        ],
      }
    }
  }
  return gameSnippet(options)
}
