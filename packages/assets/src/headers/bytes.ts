/** Big- and little-endian readers that return `undefined` past the end instead of throwing. */
export interface Reader {
  bytes: Uint8Array
  length: number
  u8(at: number): number | undefined
  u16(at: number, little?: boolean): number | undefined
  u24le(at: number): number | undefined
  u32(at: number, little?: boolean): number | undefined
  u64(at: number): number | undefined
  ascii(at: number, length: number): string
}

export function reader(bytes: Uint8Array): Reader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fits = (at: number, size: number) => at >= 0 && at + size <= bytes.byteLength
  return {
    bytes,
    length: bytes.byteLength,
    u8: (at) => (fits(at, 1) ? view.getUint8(at) : undefined),
    u16: (at, little = false) => (fits(at, 2) ? view.getUint16(at, little) : undefined),
    u24le: (at) =>
      fits(at, 3)
        ? view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
        : undefined,
    u32: (at, little = false) => (fits(at, 4) ? view.getUint32(at, little) : undefined),
    u64: (at) => (fits(at, 8) ? Number(view.getBigUint64(at, false)) : undefined),
    ascii: (at, length) =>
      fits(at, length) ? String.fromCharCode(...bytes.subarray(at, at + length)) : '',
  }
}

/** Index of `needle` (ASCII) in `bytes` from `from`, or -1. */
export function indexOfAscii(bytes: Uint8Array, needle: string, from = 0, until = bytes.length) {
  const codes = Array.from({ length: needle.length }, (_, index) => needle.charCodeAt(index))
  const end = Math.min(until, bytes.length) - codes.length
  outer: for (let at = from; at <= end; at++) {
    for (let index = 0; index < codes.length; index++) {
      if (bytes[at + index] !== codes[index]) continue outer
    }
    return at
  }
  return -1
}

/** One ISO base media file format box (MP4, M4A, AVIF). */
export interface Box {
  type: string
  start: number
  /** First byte of the payload, after the size, type and large size. */
  body: number
  end: number
}

/** Boxes between `from` and `to`, stopping at the first malformed one. */
export function boxes(read: Reader, from: number, to: number): Box[] {
  const found: Box[] = []
  let at = from
  while (at + 8 <= to) {
    const size32 = read.u32(at)
    if (size32 === undefined) break
    const type = read.ascii(at + 4, 4)
    let body = at + 8
    let size = size32
    if (size32 === 1) {
      size = read.u64(at + 8) ?? 0
      body = at + 16
    } else if (size32 === 0) {
      size = to - at
    }
    if (size < body - at || at + size > to) break
    found.push({ type, start: at, body, end: at + size })
    at += size
  }
  return found
}
