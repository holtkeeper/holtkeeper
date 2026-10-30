import type { ImageMeta } from '../data.ts'
import { boxes, indexOfAscii, reader } from './bytes.ts'

const pngColorTypes: Record<number, string> = {
  0: 'grayscale',
  2: 'rgb',
  3: 'indexed',
  4: 'grayscale-alpha',
  6: 'rgba',
}

/** Size, bit depth, alpha (color type or `tRNS`) and animation (`acTL`) of a PNG or APNG. */
export function parsePng(bytes: Uint8Array): ImageMeta | undefined {
  const read = reader(bytes)
  if (read.u32(0) !== 0x89504e47 || read.u32(4) !== 0x0d0a1a0a || read.ascii(12, 4) !== 'IHDR') {
    return undefined
  }
  const width = read.u32(16)
  const height = read.u32(20)
  const bitDepth = read.u8(24)
  const colorType = read.u8(25)
  if (width === undefined || height === undefined || colorType === undefined) return undefined
  let alpha = colorType === 4 || colorType === 6
  let frames: number | undefined
  let at = 8
  while (at + 8 <= read.length) {
    const length = read.u32(at) ?? 0
    const type = read.ascii(at + 4, 4)
    if (type === 'tRNS') alpha = true
    if (type === 'acTL') frames = read.u32(at + 8)
    if (type === 'IDAT' || type === 'IEND') break
    at += 12 + length
  }
  return {
    width,
    height,
    alpha,
    ...(bitDepth === undefined ? {} : { bitDepth }),
    animated: (frames ?? 1) > 1,
    ...(frames === undefined ? {} : { frames }),
    ...(pngColorTypes[colorType] ? { codec: pngColorTypes[colorType] } : {}),
  }
}

/** Size and precision from the first start-of-frame marker of a JPEG. */
export function parseJpeg(bytes: Uint8Array): ImageMeta | undefined {
  const read = reader(bytes)
  if (read.u16(0) !== 0xffd8) return undefined
  let at = 2
  while (at + 4 <= read.length) {
    if (read.u8(at) !== 0xff) return undefined
    const marker = read.u8(at + 1) ?? 0
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return undefined
    const length = read.u16(at + 2) ?? 0
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isFrame) {
      const bitDepth = read.u8(at + 4)
      const height = read.u16(at + 5)
      const width = read.u16(at + 7)
      if (width === undefined || height === undefined) return undefined
      return {
        width,
        height,
        alpha: false,
        ...(bitDepth === undefined ? {} : { bitDepth }),
        animated: false,
        codec: marker === 0xc2 ? 'progressive' : 'baseline',
      }
    }
    at += 2 + length
  }
  return undefined
}

function skipSubBlocks(bytes: Uint8Array, from: number): number {
  let at = from
  while (at < bytes.length) {
    const size = bytes[at] ?? 0
    at += 1 + size
    if (size === 0) break
  }
  return at
}

/** Size, frame count and transparency (graphic control extension) of a GIF. */
export function parseGif(bytes: Uint8Array): ImageMeta | undefined {
  const read = reader(bytes)
  const signature = read.ascii(0, 6)
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return undefined
  const width = read.u16(6, true)
  const height = read.u16(8, true)
  const flags = read.u8(10)
  if (width === undefined || height === undefined || flags === undefined) return undefined
  let at = 13
  if (flags & 0x80) at += 3 * 2 ** ((flags & 7) + 1)
  let frames = 0
  let alpha = false
  while (at < read.length) {
    const block = read.u8(at)
    if (block === 0x3b || block === undefined) break
    if (block === 0x21) {
      const label = read.u8(at + 1)
      if (label === 0xf9 && ((read.u8(at + 3) ?? 0) & 1) === 1) alpha = true
      at = skipSubBlocks(bytes, at + 2)
    } else if (block === 0x2c) {
      frames++
      const local = read.u8(at + 9) ?? 0
      at += 10
      if (local & 0x80) at += 3 * 2 ** ((local & 7) + 1)
      at = skipSubBlocks(bytes, at + 1)
    } else {
      break
    }
  }
  return {
    width,
    height,
    alpha,
    bitDepth: ((flags >> 4) & 7) + 1,
    animated: frames > 1,
    frames: Math.max(frames, 1),
  }
}

/** Size, alpha, animation and codec of a WebP (simple lossy, lossless or extended). */
export function parseWebp(bytes: Uint8Array): ImageMeta | undefined {
  const read = reader(bytes)
  if (read.ascii(0, 4) !== 'RIFF' || read.ascii(8, 4) !== 'WEBP') return undefined
  const chunk = read.ascii(12, 4)
  if (chunk === 'VP8 ') {
    if (read.u8(23) !== 0x9d || read.u8(24) !== 0x01 || read.u8(25) !== 0x2a) return undefined
    const width = (read.u16(26, true) ?? 0) & 0x3fff
    const height = (read.u16(28, true) ?? 0) & 0x3fff
    return { width, height, alpha: false, animated: false, codec: 'lossy' }
  }
  if (chunk === 'VP8L') {
    const bits = read.u32(21, true)
    if (read.u8(20) !== 0x2f || bits === undefined) return undefined
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      alpha: ((bits >>> 28) & 1) === 1,
      animated: false,
      codec: 'lossless',
    }
  }
  if (chunk === 'VP8X') {
    const flags = read.u8(20) ?? 0
    const width = (read.u24le(24) ?? 0) + 1
    const height = (read.u24le(27) ?? 0) + 1
    let frames = 0
    let lossless = false
    let at = 12
    while (at + 8 <= read.length) {
      const type = read.ascii(at, 4)
      const size = read.u32(at + 4, true) ?? 0
      if (type === 'ANMF') {
        frames++
        if (read.ascii(at + 24, 4) === 'VP8L') lossless = true
      }
      if (type === 'VP8L') lossless = true
      at += 8 + size + (size % 2)
    }
    const animated = (flags & 0x02) !== 0
    return {
      width,
      height,
      alpha: (flags & 0x10) !== 0,
      animated,
      ...(animated ? { frames } : {}),
      codec: lossless ? 'lossless' : 'lossy',
    }
  }
  return undefined
}

const avifBrands = new Set(['avif', 'avis'])

/**
 * Size (`ispe`), bit depth (`pixi`), alpha (an auxiliary alpha image) and animation (`avis`
 * brand) of an AVIF. The item properties are searched by box type inside `meta`, which is enough
 * for the primary image of files written by common encoders.
 */
export function parseAvif(bytes: Uint8Array): ImageMeta | undefined {
  const read = reader(bytes)
  const top = boxes(read, 0, read.length)
  const ftyp = top.find((box) => box.type === 'ftyp')
  if (!ftyp) return undefined
  const brands = [read.ascii(ftyp.body, 4)]
  for (let at = ftyp.body + 8; at + 4 <= ftyp.end; at += 4) brands.push(read.ascii(at, 4))
  if (!brands.some((brand) => avifBrands.has(brand))) return undefined
  const meta = top.find((box) => box.type === 'meta')
  const from = meta?.start ?? 0
  const to = meta?.end ?? Math.min(read.length, 64 * 1024)
  const ispe = indexOfAscii(bytes, 'ispe', from, to)
  if (ispe === -1) return undefined
  const width = read.u32(ispe + 8)
  const height = read.u32(ispe + 12)
  if (width === undefined || height === undefined) return undefined
  const pixi = indexOfAscii(bytes, 'pixi', from, to)
  const bitDepth = pixi === -1 ? undefined : read.u8(pixi + 9)
  const animated = brands.includes('avis')
  return {
    width,
    height,
    alpha: indexOfAscii(bytes, 'auxiliary:alpha', from, to) !== -1,
    ...(bitDepth === undefined ? {} : { bitDepth }),
    animated,
  }
}

const svgLength = (value: string | undefined) => {
  const match = value ? /^\s*([\d.]+)\s*(px)?\s*$/.exec(value) : null
  return match?.[1] ? Number(match[1]) : undefined
}

/** Intrinsic size of an SVG from `width`/`height` in pixels, falling back to `viewBox`. */
export function parseSvg(bytes: Uint8Array): ImageMeta | undefined {
  const text = new TextDecoder().decode(bytes.subarray(0, 64 * 1024))
  const tag = /<svg\b([^>]*)>/i.exec(text)?.[1]
  if (tag === undefined) return undefined
  const attribute = (name: string) =>
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]
  const box = attribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  const width = svgLength(attribute('width')) ?? box?.[2]
  const height = svgLength(attribute('height')) ?? box?.[3]
  if (width === undefined || height === undefined || Number.isNaN(width + height)) return undefined
  return {
    width,
    height,
    alpha: true,
    animated: /<animate|@keyframes/i.test(text),
    codec: 'vector',
  }
}

/** Size and bit depth of a Windows bitmap. */
export function parseBmp(bytes: Uint8Array): ImageMeta | undefined {
  const read = reader(bytes)
  if (read.ascii(0, 2) !== 'BM') return undefined
  const width = read.u32(18, true)
  const height = read.u32(22, true)
  const bitDepth = read.u16(28, true)
  if (width === undefined || height === undefined) return undefined
  return {
    width: width | 0,
    height: Math.abs(height | 0),
    alpha: bitDepth === 32,
    ...(bitDepth === undefined ? {} : { bitDepth }),
    animated: false,
  }
}

/** The largest image of an icon file; `frames` is the number of sizes it holds. */
export function parseIco(bytes: Uint8Array): ImageMeta | undefined {
  const read = reader(bytes)
  if (read.u16(0) !== 0 || read.u16(2, true) !== 1) return undefined
  const count = read.u16(4, true) ?? 0
  let best: ImageMeta | undefined
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 16
    const width = read.u8(at)
    const height = read.u8(at + 1)
    if (width === undefined || height === undefined) break
    const size = { width: width || 256, height: height || 256 }
    const bitDepth = read.u16(at + 6, true)
    if (!best || size.width * size.height > best.width * best.height) {
      best = {
        ...size,
        alpha: bitDepth === 32,
        ...(bitDepth ? { bitDepth } : {}),
        animated: false,
        frames: count,
      }
    }
  }
  return best
}
