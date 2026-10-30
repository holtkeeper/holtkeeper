import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import type { SnippetFramework } from '@holtkeeper/media'

import { defaultIgnore, scanFiles } from './inventory.ts'
import { generatedIgnore } from './references.ts'

/** Files whose image usages can be rewritten. */
export const usagePatterns = ['**/*.{html,htm,jsx,tsx,vue}', '**/*.{css,scss,less}']

/** Folders whose files are served from the site root (`/hero.png` → `public/hero.png`). */
const servedRoots = ['public', 'static', '']

/** One `<img>` tag or CSS `url()` declaration that loads a repository image. */
export interface ImageReference {
  /** Repository path of the file containing the usage. */
  file: string
  /** Repository path of the image. */
  asset: string
  kind: 'img' | 'css'
  framework: Extract<SnippetFramework, 'html' | 'react' | 'vue' | 'css'>
  /** Offsets of `text` in the file. */
  start: number
  end: number
  /** The exact tag or declaration. */
  text: string
  /** The image URL as written, e.g. `/hero.png`. */
  src: string
  /** Leading whitespace of the line, for multi-line replacements. */
  indent: string
  /** 1-based line of `start`. */
  line: number
  /** `<img>` attributes other than src/srcset/sizes/width/height/alt/loading/decoding, verbatim. */
  attributes?: string
  alt?: string
  width?: number
  height?: number
  /** CSS property, `background-image` or `background`. */
  property?: string
  /** CSS value as written. */
  value?: string
}

const frameworkOf = (file: string): ImageReference['framework'] => {
  if (/\.(?:jsx|tsx)$/.test(file)) return 'react'
  if (file.endsWith('.vue')) return 'vue'
  if (/\.(?:css|scss|less)$/.test(file)) return 'css'
  return 'html'
}

/**
 * The repository image a URL in `file` points at: relative URLs resolve against the file, `/x`
 * against the served roots (`public/`, `static/`, the repository root), `@/` and `~/` against
 * `src/`. Remote, data and templated URLs never match.
 */
export function resolveImage(
  file: string,
  src: string,
  assets: ReadonlySet<string>,
): string | undefined {
  if (/^(?:[a-z]+:|\/\/)|[{}$`]/i.test(src)) return undefined
  const clean = src.replace(/[?#].*$/, '')
  const candidates: string[] = []
  if (clean.startsWith('/'))
    for (const root of servedRoots) candidates.push(posix.join(root, clean))
  else if (/^[@~]\//.test(clean)) candidates.push(posix.join('src', clean.slice(2)))
  else {
    candidates.push(posix.join(posix.dirname(file), clean))
    for (const root of servedRoots) candidates.push(posix.join(root, clean))
  }
  return candidates.map((path) => path.replace(/^\/+/, '')).find((path) => assets.has(path))
}

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1

const lineOf = (text: string, offset: number) => {
  let line = 1
  for (
    let index = text.indexOf('\n');
    index !== -1 && index < offset;
    index = text.indexOf('\n', index + 1)
  )
    line++
  return line
}

const ATTRIBUTE =
  /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\}|(\{[^}]*\})))?/g

const handled = new Set([
  'src',
  'srcset',
  'srcSet',
  'sizes',
  'width',
  'height',
  'alt',
  'loading',
  'decoding',
])

/** `<img>` usages of the given assets in one file; tags inside `<picture>` or with `srcset` are left alone. */
export function imgReferences(
  file: string,
  text: string,
  assets: ReadonlySet<string>,
): ImageReference[] {
  const found: ImageReference[] = []
  for (const match of text.matchAll(/<img\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*)\/?>/g)) {
    const start = match.index
    const before = text.slice(0, start)
    if (before.lastIndexOf('<picture') > before.lastIndexOf('</picture>')) continue
    const attributes = new Map<string, { value?: string; literal: boolean; raw: string }>()
    for (const attribute of (match[1] ?? '').matchAll(ATTRIBUTE)) {
      const name = attribute[1] ?? ''
      const literal = attribute[2] ?? attribute[3] ?? attribute[4] ?? attribute[5] ?? attribute[6]
      attributes.set(name, {
        ...(literal === undefined ? {} : { value: literal }),
        literal: literal !== undefined || attribute[7] === undefined,
        raw: attribute[0],
      })
    }
    if (
      attributes.has('srcset') ||
      attributes.has('srcSet') ||
      attributes.has(':src') ||
      attributes.has('v-bind:src')
    )
      continue
    const src = attributes.get('src')
    if (!src?.value || !src.literal) continue
    const asset = resolveImage(file, src.value, assets)
    if (!asset) continue
    const number = (name: string) => {
      const entry = attributes.get(name)
      const raw = entry?.value ?? entry?.raw.match(/\{\s*(\d+)\s*\}/)?.[1]
      const value = raw === undefined ? Number.NaN : Number.parseFloat(raw)
      return Number.isFinite(value) && value > 0 ? value : undefined
    }
    const width = number('width')
    const height = number('height')
    const alt = attributes.get('alt')?.value
    const rest = [...attributes]
      .filter(([name]) => !handled.has(name) && name !== '/')
      .map(([, entry]) => entry.raw)
      .join(' ')
    const lineBegin = lineStart(text, start)
    found.push({
      file,
      asset,
      kind: 'img',
      framework: frameworkOf(file),
      start,
      end: start + match[0].length,
      text: match[0],
      src: src.value,
      indent: text.slice(lineBegin, start).match(/^\s*/)?.[0] ?? '',
      line: lineOf(text, start),
      ...(rest ? { attributes: rest } : {}),
      ...(alt === undefined ? {} : { alt }),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    })
  }
  return found
}

/** `background`/`background-image` declarations with a `url()` of the given assets, not already using `image-set()`. */
export function cssReferences(
  file: string,
  text: string,
  assets: ReadonlySet<string>,
): ImageReference[] {
  const found: ImageReference[] = []
  for (const match of text.matchAll(
    /(background(?:-image)?)\s*:\s*([^;{}]*?url\(\s*(["']?)([^"')]+)\3\s*\)[^;{}]*?)\s*(;|(?=\}))/g,
  )) {
    const property = match[1] ?? ''
    const value = match[2] ?? ''
    if (/image-set\(/.test(value)) continue
    const block = text.slice(text.lastIndexOf('{', match.index) + 1, text.indexOf('}', match.index))
    if (block.includes('image-set(')) continue
    const src = match[4] ?? ''
    const asset = resolveImage(file, src, assets)
    if (!asset) continue
    const start = match.index
    const lineBegin = lineStart(text, start)
    found.push({
      file,
      asset,
      kind: 'css',
      framework: 'css',
      start,
      end: start + match[0].length,
      text: match[0],
      src,
      indent: text.slice(lineBegin, start).match(/^\s*/)?.[0] ?? '',
      line: lineOf(text, start),
      property,
      value,
    })
  }
  return found
}

/** Text of every file whose usages can be rewritten, by repository path. */
export async function usageSources(
  dir: string,
  ignore: readonly string[] = [],
): Promise<Map<string, string>> {
  const files = await scanFiles(dir, usagePatterns, [
    ...defaultIgnore,
    ...generatedIgnore,
    ...ignore,
  ])
  const sources = new Map<string, string>()
  for (const file of files) {
    const content = await readFile(join(dir, file))
    if (content.byteLength <= 2 * 1024 * 1024) sources.set(file, content.toString('utf8'))
  }
  return sources
}

/** Every `<img>` and CSS usage of `assets` in `sources`, grouped by image path. */
export function findReferences(
  sources: ReadonlyMap<string, string>,
  assets: ReadonlySet<string>,
): Map<string, ImageReference[]> {
  const byAsset = new Map<string, ImageReference[]>()
  for (const [file, text] of sources) {
    const found = /\.(?:css|scss|less)$/.test(file)
      ? cssReferences(file, text, assets)
      : imgReferences(file, text, assets)
    for (const reference of found) {
      const list = byAsset.get(reference.asset) ?? []
      list.push(reference)
      byAsset.set(reference.asset, list)
    }
  }
  return byAsset
}
