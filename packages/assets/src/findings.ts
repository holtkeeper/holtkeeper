import type { Asset, Duplicate, Finding } from './data.ts'

/** Largest texture side most mobile GPUs accept. */
export const MAX_TEXTURE_SIDE = 4096

/** Images smaller than this on both sides are UI bits where power-of-two sizes rarely matter. */
const NPOT_MIN_SIDE = 64

const isPowerOfTwo = (value: number) => value > 0 && (value & (value - 1)) === 0

export interface FindingOptions {
  /** Game engines of the project; power-of-two checks run only when there is one. */
  engines: readonly string[]
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
