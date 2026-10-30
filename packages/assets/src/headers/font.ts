import { inflateSync } from 'node:zlib'

import type { FontMeta } from '../data.ts'
import { reader } from './bytes.ts'

/**
 * Container format and glyph count (`maxp.numGlyphs`) of a TrueType, OpenType, collection or
 * WOFF font. WOFF2 reports only its format: its tables sit in one brotli stream with transformed
 * glyph data, which is not worth decoding for a count.
 */
export function parseFont(bytes: Uint8Array): FontMeta | undefined {
  const read = reader(bytes)
  const tag = read.ascii(0, 4)
  if (tag === 'wOF2') return { format: 'woff2' }
  if (tag === 'ttcf') return { format: 'collection' }
  if (tag === 'wOFF') {
    const tables = read.u16(12) ?? 0
    for (let index = 0; index < tables; index++) {
      const at = 44 + index * 20
      if (read.ascii(at, 4) !== 'maxp') continue
      const offset = read.u32(at + 4) ?? 0
      const compressed = read.u32(at + 8) ?? 0
      const original = read.u32(at + 12) ?? 0
      const raw = bytes.subarray(offset, offset + compressed)
      const table = compressed < original ? new Uint8Array(inflateSync(raw)) : raw
      const glyphs = reader(table).u16(4)
      return { format: 'woff', ...(glyphs === undefined ? {} : { glyphs }) }
    }
    return { format: 'woff' }
  }
  const version = read.u32(0)
  if (version !== 0x00010000 && tag !== 'true' && tag !== 'OTTO') return undefined
  const format = tag === 'OTTO' ? 'opentype' : 'truetype'
  const tables = read.u16(4) ?? 0
  for (let index = 0; index < tables; index++) {
    const at = 12 + index * 16
    if (read.ascii(at, 4) !== 'maxp') continue
    const glyphs = read.u16((read.u32(at + 8) ?? 0) + 4)
    return { format, ...(glyphs === undefined ? {} : { glyphs }) }
  }
  return { format }
}
