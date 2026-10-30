import { gzipSync } from 'node:zlib'

import { type Config, optimize } from 'svgo'

/**
 * - `safe`: keeps every ID, element type, `<style>`, inline `style`, hidden element and
 *   description, so CSS and scripts addressing the SVG keep working; only drops editor cruft,
 *   comments and metadata and shortens numbers and path data.
 * - `default`: svgo's preset-default plus `convertStyleToAttrs`; minifies unreferenced IDs.
 * - `aggressive`: also reuses paths, drops off-canvas paths and xlink, with one decimal less.
 */
export type SvgPreset = 'safe' | 'default' | 'aggressive'

export interface SvgOptimizeOptions {
  preset?: SvgPreset
  /** Decimals kept in numbers and path data; default 3 (2 for `aggressive`). */
  precision?: number
  /** Repeat passes until nothing changes. Default true. */
  multipass?: boolean
  /** IDs that must survive (referenced from outside the SVG); `safe` keeps all of them anyway. */
  keepIds?: string[]
}

/** Path data numbers of a document. */
export interface PathStats {
  /** Elements with a `d` attribute. */
  paths: number
  /** Path commands (`M`, `c`, `Z`, ...). */
  commands: number
  /** Numbers in path data. */
  coordinates: number
  /** Digits in those numbers. */
  digits: number
  /** Characters of `d` of the longest paths, longest first (up to 3). */
  longest: { length: number; id?: string }[]
}

export interface SvgIssue {
  code:
    | 'missing-viewbox'
    | 'size-without-viewbox'
    | 'aspect-mismatch'
    | 'embedded-raster'
    | 'viewbox-restored'
  message: string
}

/** What an optimization changed, for reports. */
export interface SvgBreakdown {
  /** Element name → elements removed. */
  removedElements: Record<string, number>
  /** Attribute name → occurrences removed. */
  removedAttributes: Record<string, number>
  /** Metadata removed: `<metadata>`, editor namespaces (Inkscape, Sketch, Illustrator), `<?xml?>`, doctype. */
  metadata: number
  comments: number
  paths: { before: PathStats; after: PathStats }
  /** `style="..."` attributes and `<style>` elements before and after. */
  styles: {
    inlineBefore: number
    inlineAfter: number
    elementsBefore: number
    elementsAfter: number
  }
  /** IDs before and after; `minified` are new short names (always 0 for `safe`). */
  ids: { before: number; after: number; minified: number }
  issues: SvgIssue[]
}

export interface SvgOptimization {
  text: string
  preset: SvgPreset
  bytes: { before: number; after: number }
  /** Gzip level 9 sizes, what a server actually sends. */
  gzip: { before: number; after: number }
  breakdown: SvgBreakdown
}

interface Tag {
  name: string
  attributes: Map<string, string>
}

const editorPrefixes = /^(?:sodipodi|inkscape|sketch|i|x|a|graph|illustrator|serif|figma):/i

/** Tags with their attributes; comments, CDATA and processing instructions are skipped. */
export function scanTags(text: string): Tag[] {
  const stripped = text.replace(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/gi,
    '',
  )
  const tags: Tag[] = []
  for (const match of stripped.matchAll(
    /<([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*\/?>/g,
  )) {
    const attributes = new Map<string, string>()
    for (const attribute of (match[2] ?? '').matchAll(
      /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g,
    )) {
      attributes.set(attribute[1] ?? '', attribute[2] ?? attribute[3] ?? '')
    }
    tags.push({ name: match[1] ?? '', attributes })
  }
  return tags
}

const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g

/** Command, coordinate and digit counts of every `d` attribute. */
export function pathStats(tags: readonly Tag[]): PathStats {
  let paths = 0
  let commands = 0
  let coordinates = 0
  let digits = 0
  const lengths: { length: number; id?: string }[] = []
  for (const tag of tags) {
    const d = tag.attributes.get('d')
    if (d === undefined) continue
    paths++
    commands += d.match(/[MmLlHhVvCcSsQqTtAaZz]/g)?.length ?? 0
    for (const number of d.match(NUMBER) ?? []) {
      coordinates++
      digits += number.replace(/e.*$/i, '').replace(/\D/g, '').length
    }
    const id = tag.attributes.get('id')
    lengths.push({ length: d.length, ...(id ? { id } : {}) })
  }
  return {
    paths,
    commands,
    coordinates,
    digits,
    longest: lengths.toSorted((a, b) => b.length - a.length).slice(0, 3),
  }
}

const countBy = <T>(items: readonly T[], key: (item: T) => string[]) => {
  const counts = new Map<string, number>()
  for (const item of items)
    for (const name of key(item)) counts.set(name, (counts.get(name) ?? 0) + 1)
  return counts
}

const decrease = (before: Map<string, number>, after: Map<string, number>) => {
  const removed: Record<string, number> = {}
  for (const [name, count] of [...before].toSorted(([a], [b]) => a.localeCompare(b))) {
    const lost = count - (after.get(name) ?? 0)
    if (lost > 0) removed[name] = lost
  }
  return removed
}

function sizeIssues(root: Tag | undefined, tags: readonly Tag[]): SvgIssue[] {
  const issues: SvgIssue[] = []
  if (!root) return issues
  const viewBox = root.attributes.get('viewBox')
  const width = Number.parseFloat(root.attributes.get('width') ?? '')
  const height = Number.parseFloat(root.attributes.get('height') ?? '')
  if (!viewBox) {
    issues.push(
      Number.isFinite(width) && Number.isFinite(height)
        ? {
            code: 'size-without-viewbox',
            message: `width/height (${width}×${height}) without a viewBox: the SVG cannot scale; add viewBox="0 0 ${width} ${height}"`,
          }
        : {
            code: 'missing-viewbox',
            message: 'No viewBox and no size: browsers fall back to 300×150',
          },
    )
  } else if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const [, , boxWidth, boxHeight] = viewBox.split(/[\s,]+/).map(Number)
    if (boxWidth && boxHeight && Math.abs(boxWidth / boxHeight - width / height) > 0.01)
      issues.push({
        code: 'aspect-mismatch',
        message: `viewBox ${boxWidth}×${boxHeight} and size ${width}×${height} have different aspect ratios`,
      })
  }
  const rasters = tags.filter(
    (tag) =>
      tag.name === 'image' &&
      /^data:image\/(?:png|jpe?g|webp|gif)/.test(
        tag.attributes.get('href') ?? tag.attributes.get('xlink:href') ?? '',
      ),
  ).length
  if (rasters)
    issues.push({
      code: 'embedded-raster',
      message: `${rasters} embedded raster image${rasters === 1 ? '' : 's'}: optimize or extract them, svgo cannot`,
    })
  return issues
}

function configFor(preset: SvgPreset, options: SvgOptimizeOptions): Config {
  const precision = options.precision ?? (preset === 'aggressive' ? 2 : 3)
  const multipass = options.multipass ?? true
  if (preset === 'safe') {
    return {
      multipass,
      floatPrecision: precision,
      plugins: [
        {
          name: 'preset-default',
          params: {
            overrides: {
              cleanupIds: false,
              inlineStyles: false,
              minifyStyles: { usage: false },
              removeHiddenElems: false,
              removeDesc: false,
              mergePaths: false,
              convertShapeToPath: false,
              convertEllipseToCircle: false,
              collapseGroups: false,
              moveElemsAttrsToGroup: false,
              moveGroupAttrsToElems: false,
              removeUnknownsAndDefaults: {
                keepDataAttrs: true,
                keepAriaAttrs: true,
                keepRoleAttr: true,
              },
            },
          },
        },
      ],
    }
  }
  const keep = options.keepIds?.length ? { cleanupIds: { preserve: options.keepIds } } : {}
  return {
    multipass,
    floatPrecision: precision,
    plugins: [
      { name: 'preset-default', params: { overrides: keep } },
      'convertStyleToAttrs',
      ...(preset === 'aggressive'
        ? (['removeXlink', 'reusePaths', 'removeOffCanvasPaths'] as const)
        : []),
    ],
  }
}

const prolog = (value: string) =>
  (/<\?xml[\s\S]*?\?>/.test(value) ? 1 : 0) + (/<!DOCTYPE/i.test(value) ? 1 : 0)
const commentCount = (value: string) => value.match(/<!--[\s\S]*?-->/g)?.length ?? 0
const idsOf = (tags: readonly Tag[]) =>
  new Set(tags.flatMap((tag) => (tag.attributes.has('id') ? [tag.attributes.get('id') ?? ''] : [])))

const gzipBytes = (text: string) => gzipSync(Buffer.from(text), { level: 9 }).byteLength

/**
 * Optimizes an SVG with svgo and explains the result. `viewBox` is never removed (restored if a
 * plugin dropped it); `safe` keeps every ID so CSS and scripts addressing them keep working.
 * Throws when svgo cannot parse the text.
 */
export function optimizeSvg(text: string, options: SvgOptimizeOptions = {}): SvgOptimization {
  const preset = options.preset ?? 'default'
  let output = optimize(text, configFor(preset, options)).data
  const before = scanTags(text)
  let after = scanTags(output)
  const issues = sizeIssues(
    before.find((tag) => tag.name === 'svg'),
    before,
  )
  const originalBox = before.find((tag) => tag.name === 'svg')?.attributes.get('viewBox')
  if (originalBox && !after.find((tag) => tag.name === 'svg')?.attributes.has('viewBox')) {
    output = output.replace(/<svg\b/, `<svg viewBox="${originalBox}"`)
    after = scanTags(output)
    issues.push({ code: 'viewbox-restored', message: 'viewBox was dropped by svgo and restored' })
  }
  const beforeElements = countBy(before, (tag) => [tag.name])
  const afterElements = countBy(after, (tag) => [tag.name])
  const removedElements = decrease(beforeElements, afterElements)
  const removedAttributes = decrease(
    countBy(before, (tag) => [...tag.attributes.keys()]),
    countBy(after, (tag) => [...tag.attributes.keys()]),
  )
  const metadata =
    Object.entries(removedElements)
      .filter(([name]) => name === 'metadata' || editorPrefixes.test(name))
      .reduce((total, [, count]) => total + count, 0) + Math.max(0, prolog(text) - prolog(output))
  const idsBefore = idsOf(before)
  const idsAfter = idsOf(after)
  return {
    text: output,
    preset,
    bytes: { before: Buffer.byteLength(text), after: Buffer.byteLength(output) },
    gzip: { before: gzipBytes(text), after: gzipBytes(output) },
    breakdown: {
      removedElements,
      removedAttributes,
      metadata,
      comments: Math.max(0, commentCount(text) - commentCount(output)),
      paths: { before: pathStats(before), after: pathStats(after) },
      styles: {
        inlineBefore: before.filter((tag) => tag.attributes.has('style')).length,
        inlineAfter: after.filter((tag) => tag.attributes.has('style')).length,
        elementsBefore: beforeElements.get('style') ?? 0,
        elementsAfter: afterElements.get('style') ?? 0,
      },
      ids: {
        before: idsBefore.size,
        after: idsAfter.size,
        minified: [...idsAfter].filter((id) => !idsBefore.has(id)).length,
      },
      issues,
    },
  }
}
