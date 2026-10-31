import type { Asset, Duplicate, Finding } from './data.ts'
import { type ImageFamily, hasSizes, modernFormats } from './families.ts'

/** Largest texture side most mobile GPUs accept. */
export const MAX_TEXTURE_SIDE = 4096

/** Images smaller than this on both sides are UI bits where power-of-two sizes rarely matter. */
const NPOT_MIN_SIDE = 64

const isPowerOfTwo = (value: number) => value > 0 && (value & (value - 1)) === 0

/** Images wider than this without smaller sizes are reported as `single-resolution`. */
export const HIGH_RES_WIDTH = 1280

/** Legacy raster formats that should come with AVIF/WebP versions. */
const legacyFormats = new Set(['png', 'apng', 'jpeg', 'jpg', 'gif'])

const formatNames: Record<string, string> = { avif: 'AVIF', webp: 'WebP' }

export interface FindingOptions {
  /** Game engines of the project; power-of-two checks run only when there is one. */
  engines: readonly string[]
  /** Image families from `imageFamilies`; delivery checks (`missing-modern-formats`, `single-resolution`) run only with them. */
  families?: readonly ImageFamily[]
  /** Rasters below this get no `missing-modern-formats` finding. Default 8 kB. */
  minBytes?: number
  /** Expect AVIF next to WebP. Default false. */
  avif?: boolean
}

/**
 * PNG/JPEG/GIF originals without a WebP version (and AVIF, with `avif`) next to them, and originals wider than
 * `HIGH_RES_WIDTH` without smaller widths or densities, so every screen downloads the largest file.
 */
export function deliveryIssues(
  families: readonly ImageFamily[],
  options: { engines: readonly string[]; minBytes?: number; avif?: boolean },
): Finding[] {
  const minBytes = options.minBytes ?? 8 * 1024
  const findings: Finding[] = []
  const expected = modernFormats(options.avif)
  for (const family of families) {
    const { original } = family
    const missing = expected.filter((format) => !family.formats.has(format))
    if (legacyFormats.has(original.format) && original.bytes >= minBytes && missing.length) {
      const names = missing.map((format) => formatNames[format]).join(' and ')
      findings.push({
        id: `missing-modern-formats:${original.path}`,
        rule: 'missing-modern-formats',
        path: original.path,
        tone: missing.length === expected.length ? 'warning' : 'info',
        title: `${original.path} has no ${names} version`,
        detail: `Browsers that support ${names} would download a smaller file through <picture> or image-set(); generate the variants and serve the ${original.format.toUpperCase()} as the fallback.`,
      })
    }
    const width = original.image?.width ?? 0
    if (width > HIGH_RES_WIDTH && !hasSizes(family) && !original.image?.animated) {
      findings.push({
        id: `single-resolution:${original.path}`,
        rule: 'single-resolution',
        path: original.path,
        tone: options.engines.length ? 'info' : 'warning',
        title: `${original.path} exists only at ${width}×${original.image?.height ?? 0}`,
        detail: options.engines.length
          ? 'Ship lower-density textures (@1x) for small screens and pick one from devicePixelRatio.'
          : 'Phones download the full-size file; add smaller widths with srcset/sizes (or image-set()) so each screen gets a file close to its size.',
      })
    }
  }
  return findings
}

/**
 * Oversized raster images (a side above `MAX_TEXTURE_SIDE`), non-power-of-two textures in game
 * projects and source assets nothing seems to reference. Build outputs are skipped: they mirror
 * source files under hashed names.
 */
export function findIssues(assets: readonly Asset[], options: FindingOptions): Finding[] {
  const findings: Finding[] = []
  for (const asset of assets) {
    if (asset.origin === 'build') continue
    const image = asset.image
    if (image && image.codec !== 'vector') {
      const side = Math.max(image.width, image.height)
      if (side > MAX_TEXTURE_SIDE) {
        findings.push({
          id: `huge-dimensions:${asset.path}`,
          rule: 'huge-dimensions',
          path: asset.path,
          tone: 'warning',
          title: `${asset.path} is ${image.width}×${image.height}`,
          detail: `Above ${MAX_TEXTURE_SIDE} px many mobile GPUs cannot load it as one texture, and it rarely fits any screen.`,
        })
      }
      const npot = !isPowerOfTwo(image.width) || !isPowerOfTwo(image.height)
      if (options.engines.length && npot && side >= NPOT_MIN_SIDE && asset.kind === 'image') {
        findings.push({
          id: `non-power-of-two:${asset.path}`,
          rule: 'non-power-of-two',
          path: asset.path,
          tone: 'info',
          title: `${asset.path} is not a power-of-two texture (${image.width}×${image.height})`,
          detail:
            'WebGL 1 cannot mipmap or repeat such textures and GPUs may pad them; pack it into an atlas or resize.',
        })
      }
    }
    if (asset.referenced === false) {
      findings.push({
        id: `unused:${asset.path}`,
        rule: 'unused',
        path: asset.path,
        tone: 'info',
        title: `${asset.path} looks unused`,
        detail:
          'Its file name does not appear in any source or config file. Assets loaded by computed names show up here too.',
      })
    }
  }
  if (options.families) findings.push(...deliveryIssues(options.families, options))
  return findings
}

/**
 * Files with the same content, largest waste first. A build file is not a duplicate of the source
 * file it was copied from, so build and source files are grouped separately.
 */
export function findDuplicates(assets: readonly Asset[]): Duplicate[] {
  const groups = new Map<string, Asset[]>()
  for (const asset of assets) {
    if (asset.bytes === 0) continue
    const key = `${asset.origin}:${asset.hash}`
    groups.set(key, [...(groups.get(key) ?? []), asset])
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      hash: group[0]?.hash ?? '',
      bytes: group[0]?.bytes ?? 0,
      paths: group.map((asset) => asset.path).toSorted(),
    }))
    .toSorted((a, b) => wasted(b) - wasted(a) || (a.paths[0] ?? '').localeCompare(b.paths[0] ?? ''))
}

/** Bytes that keeping one copy would save. */
export const wasted = (duplicate: Duplicate) => duplicate.bytes * (duplicate.paths.length - 1)
