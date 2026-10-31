import { posix } from 'node:path'

import type { Asset } from './data.ts'

/** Raster formats a family can hold; `jpg` is folded into `jpeg`. */
const rasterFormats = new Set(['png', 'apng', 'jpeg', 'jpg', 'gif', 'webp', 'avif'])

/** Lower is more likely the hand-made original the others were generated from. */
const originalRank: Record<string, number> = {
  png: 0,
  apng: 0,
  jpeg: 0,
  jpg: 0,
  gif: 0,
  webp: 1,
  avif: 2,
}

const VARIANT_NAME = /^(.+?)(?:-(\d+)(w)?|@(\d+(?:\.\d+)?)x)?\.([a-z0-9]+)$/i

/** One source image and the files next to it that are versions of it. */
export interface ImageFamily {
  /** The original: the legacy-format full-size file (PNG/JPEG/GIF before WebP before AVIF). */
  original: Asset
  /** Other files of the family: other formats, `-640w` or `-720` sizes, `@2x` densities. */
  members: Asset[]
  /** Formats present, the original's included (`jpg` as `jpeg`). */
  formats: Set<string>
  /** Widths of sized members: `{name}-{width}w`, or `{name}-{n}` where `n` is the file's width or height. */
  widths: number[]
  /** Densities of `{name}@{density}x` members. */
  densities: number[]
}

const normalize = (format: string) => (format === 'jpg' ? 'jpeg' : format.toLowerCase())

function parseName(asset: Asset): { key: string; width?: number; density?: number } | undefined {
  const name = posix.basename(asset.path)
  const match = name.match(VARIANT_NAME)
  if (!match) return undefined
  const dir = posix.dirname(asset.path)
  const [, base = '', size, suffix, density] = match
  if (density) return { key: posix.join(dir, base), density: Number(density) }
  if (!size) return { key: posix.join(dir, base) }
  if (suffix) return { key: posix.join(dir, base), width: Number(size) }
  const n = Number(size)
  const { width, height } = asset.image ?? {}
  if (width && (n === width || n === height)) return { key: posix.join(dir, base), width }
  return { key: posix.join(dir, name.slice(0, name.lastIndexOf('.'))) }
}

/**
 * Groups source raster images by folder and base name, so `hero.png`, `hero.webp`,
 * `hero-640w.avif` and `hero@2x.png` form one family whose original is `hero.png`. A bare
 * `-{n}` suffix (`bg-720.webp`, `bg-1080.webp`) marks a size only when `n` is the file's width or
 * height, so `level-2.png` stays its own image. Files that are not in a family with others form a
 * family of their own. Build outputs are left out.
 */
export function imageFamilies(assets: readonly Asset[]): ImageFamily[] {
  const groups = new Map<string, { asset: Asset; width?: number; density?: number }[]>()
  for (const asset of assets) {
    if (asset.origin !== 'source' || asset.kind !== 'image') continue
    if (!rasterFormats.has(asset.format.toLowerCase())) continue
    const parsed = parseName(asset)
    if (!parsed) continue
    const { key, ...size } = parsed
    const entry = { asset, ...size }
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const families: ImageFamily[] = []
  for (const entries of groups.values()) {
    const plain = entries.filter(
      (entry) => entry.width === undefined && entry.density === undefined,
    )
    const original = (plain.length ? plain : entries).toSorted(
      (a, b) =>
        (originalRank[a.asset.format] ?? 3) - (originalRank[b.asset.format] ?? 3) ||
        (b.asset.image?.width ?? 0) - (a.asset.image?.width ?? 0) ||
        b.asset.bytes - a.asset.bytes,
    )[0]
    if (!original) continue
    const members = entries.filter((entry) => entry !== original)
    families.push({
      original: original.asset,
      members: members.map((entry) => entry.asset),
      formats: new Set(entries.map((entry) => normalize(entry.asset.format))),
      widths: members.flatMap((entry) => (entry.width === undefined ? [] : [entry.width])),
      densities: members.flatMap((entry) => (entry.density === undefined ? [] : [entry.density])),
    })
  }
  return families.toSorted((a, b) => a.original.path.localeCompare(b.original.path))
}

/** Paths that are generated versions of another image (members of a family), not originals. */
export const variantPaths = (families: readonly ImageFamily[]): Set<string> =>
  new Set(families.flatMap((family) => family.members.map((member) => member.path)))

/** Modern formats a family is expected to ship: WebP, plus AVIF when `avif` is on. */
export const modernFormats = (avif = false): string[] => (avif ? ['avif', 'webp'] : ['webp'])

/** Whether the family already ships WebP, and AVIF too when `avif` is on. */
export const hasModernFormats = (family: ImageFamily, avif = false) =>
  modernFormats(avif).every((format) => family.formats.has(format))

/** Whether the family has smaller sizes than the original (widths or densities). */
export const hasSizes = (family: ImageFamily) =>
  family.widths.length > 0 || family.densities.length > 0
