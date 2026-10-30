import type { AtlasMeta } from '../data.ts'
import { reader } from './bytes.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const frameCount = (frames: unknown) =>
  Array.isArray(frames) ? frames.length : isRecord(frames) ? Object.keys(frames).length : 0

/**
 * Frames and texture names of a JSON sprite atlas: TexturePacker hash or array (`frames` +
 * `meta.image`, also used by Pixi and Phaser) and Phaser multi-atlases (`textures[]`). Other JSON
 * returns `undefined`.
 */
export function parseJsonAtlas(value: unknown): AtlasMeta | undefined {
  if (!isRecord(value)) return undefined
  if (Array.isArray(value.textures)) {
    const textures = value.textures.filter(isRecord)
    const images = textures.flatMap((texture) =>
      typeof texture.image === 'string' ? [texture.image] : [],
    )
    if (!images.length) return undefined
    const frames = textures.reduce((total, texture) => total + frameCount(texture.frames), 0)
    return { frames, images }
  }
  if (!('frames' in value) || !isRecord(value.meta)) return undefined
  const meta = value.meta
  const images = [
    ...(typeof meta.image === 'string' ? [meta.image] : []),
    ...(Array.isArray(meta.related_multi_packs)
      ? meta.related_multi_packs.filter((item): item is string => typeof item === 'string')
      : []),
  ]
  if (!images.length) return undefined
  return { frames: frameCount(value.frames), images }
}

const imageLine = /^[^:]+\.(?:png|jpe?g|webp|avif|ktx2?|basis|dds|pvr)$/i

/** Pages and regions of a libGDX / Spine `.atlas` text file. */
export function parseTextAtlas(text: string): AtlasMeta {
  const images: string[] = []
  let frames = 0
  let afterBlank = true
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      afterBlank = true
      continue
    }
    if (imageLine.test(line) && (afterBlank || images.length === 0)) images.push(line)
    else if (!line.includes(':') && !raw.startsWith(' ') && !raw.startsWith('\t')) frames++
    afterBlank = false
  }
  return { frames, images }
}

/** Pages and character count of an AngelCode bitmap font (`.fnt`, text format). */
export function parseFnt(text: string): AtlasMeta {
  const images = [...text.matchAll(/^page\b.*?\bfile="([^"]+)"/gm)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  )
  const count = /^chars\s+count=(\d+)/m.exec(text)?.[1]
  return { images, ...(count ? { frames: Number(count) } : {}) }
}

/** The JSON chunk of a binary glTF, which names its external buffers and images. */
export function glbJson(bytes: Uint8Array): string | undefined {
  const read = reader(bytes)
  if (read.ascii(0, 4) !== 'glTF' || read.ascii(16, 4) !== 'JSON') return undefined
  const length = read.u32(12, true) ?? 0
  return new TextDecoder().decode(bytes.subarray(20, 20 + length))
}
