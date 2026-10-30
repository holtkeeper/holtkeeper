import { deflateSync } from 'node:zlib'

const ascii = (text: string) =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))
const be16 = (value: number) => [(value >>> 8) & 255, value & 255]
const be32 = (value: number) => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
]
const le16 = (value: number) => [value & 255, (value >>> 8) & 255]
const le24 = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255]
const le32 = (value: number) => [...le16(value & 0xffff), ...le16(value >>> 16)]
const bytes = (...parts: (number[] | Uint8Array)[]) =>
  new Uint8Array(parts.flatMap((part) => [...part]))

const pngChunk = (type: string, data: number[]) => [
  ...be32(data.length),
  ...ascii(type),
  ...data,
  0,
  0,
  0,
  0,
]

export function png(
  width: number,
  height: number,
  options: { colorType?: number; trns?: boolean; frames?: number; padding?: number } = {},
) {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', [...be32(width), ...be32(height), 8, options.colorType ?? 2, 0, 0, 0]),
    options.frames ? pngChunk('acTL', [...be32(options.frames), ...be32(0)]) : [],
    options.trns ? pngChunk('tRNS', [0, 0]) : [],
    pngChunk(
      'IDAT',
      Array.from({ length: options.padding ?? 4 }, (_, index) => index % 251),
    ),
    pngChunk('IEND', []),
  )
}

export function jpeg(width: number, height: number, padding = 0) {
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [
      0xff,
      0xc0,
      ...be16(17),
      8,
      ...be16(height),
      ...be16(width),
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ],
    [0xff, 0xda, ...be16(2)],
    Array.from({ length: padding }, (_, index) => (index * 7) % 255),
    [0xff, 0xd9],
  )
}

export function gif(width: number, height: number, frames: number, transparent = false) {
  const frame = [
    0x21,
    0xf9,
    4,
    transparent ? 1 : 0,
    0,
    0,
    0,
    0,
    0x2c,
    0,
    0,
    0,
    0,
    ...le16(width),
    ...le16(height),
    0,
    2,
    2,
    0x4c,
    0x01,
    0,
  ]
  return bytes(
    ascii('GIF89a'),
    [...le16(width), ...le16(height), 0x80, 0, 0],
    [0, 0, 0, 255, 255, 255],
    ...Array.from({ length: frames }, () => frame),
    [0x3b],
  )
}

const riff = (form: string, body: number[]) =>
  bytes(ascii('RIFF'), le32(body.length + 4), ascii(form), body)

export const webpLossy = (width: number, height: number) =>
  riff('WEBP', [
    ...ascii('VP8 '),
    ...le32(10),
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...le16(width),
    ...le16(height),
  ])

export const webpLossless = (width: number, height: number, alpha: boolean) => {
  const bits = (width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28)
  return riff('WEBP', [...ascii('VP8L'), ...le32(5), 0x2f, ...le32(bits >>> 0)])
}

export const webpExtended = (width: number, height: number, flags: number, frames: number) =>
  riff('WEBP', [
    ...ascii('VP8X'),
    ...le32(10),
    flags,
    0,
    0,
    0,
    ...le24(width - 1),
    ...le24(height - 1),
    ...Array.from({ length: frames }, () => [
      ...ascii('ANMF'),
      ...le32(16),
      ...Array<number>(16).fill(0),
    ]).flat(),
  ])

const box = (type: string, ...body: number[][]) => {
  const content = body.flat()
  return [...be32(content.length + 8), ...ascii(type), ...content]
}
const fullBox = (type: string, ...body: number[][]) => box(type, [0, 0, 0, 0], ...body)

export function avif(
  width: number,
  height: number,
  options: { alpha?: boolean; depth?: number } = {},
) {
  return bytes(
    box('ftyp', ascii('avif'), be32(0), ascii('mif1'), ascii('avif')),
    fullBox(
      'meta',
      box(
        'iprp',
        box(
          'ipco',
          fullBox('ispe', be32(width), be32(height)),
          fullBox('pixi', [3, options.depth ?? 8, options.depth ?? 8, options.depth ?? 8]),
          ...(options.alpha
            ? [fullBox('auxC', ascii('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0'))]
            : []),
        ),
      ),
    ),
  )
}

export const svg = (attributes: string) =>
  new TextEncoder().encode(
    `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect/></svg>`,
  )

export const bmp = (width: number, height: number, depth: number) =>
  bytes(
    ascii('BM'),
    le32(0),
    le32(0),
    le32(54),
    le32(40),
    le32(width),
    le32(height >>> 0),
    le16(1),
    le16(depth),
    Array<number>(24).fill(0),
  )

export const ico = (sizes: number[]) =>
  bytes(
    [0, 0, 1, 0, ...le16(sizes.length)],
    ...sizes.map((size) => [
      size % 256,
      size % 256,
      0,
      0,
      ...le16(1),
      ...le16(32),
      ...le32(0),
      ...le32(0),
    ]),
  )

export function wav(seconds: number, sampleRate = 44100, channels = 2, bits = 16) {
  const byteRate = (sampleRate * channels * bits) / 8
  const data = Math.round(byteRate * seconds)
  return bytes(
    riff('WAVE', [
      ...ascii('fmt '),
      ...le32(16),
      ...le16(1),
      ...le16(channels),
      ...le32(sampleRate),
      ...le32(byteRate),
      ...le16((channels * bits) / 8),
      ...le16(bits),
      ...ascii('data'),
      ...le32(data),
    ]),
    new Uint8Array(data),
  )
}

/** MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo; with a Xing header when `xingFrames` is set. */
export function mp3(frames: number, xingFrames?: number) {
  const frameLength = Math.floor((144 * 128000) / 44100)
  const frame = () => {
    const data = new Uint8Array(frameLength)
    data.set([0xff, 0xfb, 0x90, 0x00])
    return data
  }
  const first = frame()
  if (xingFrames !== undefined) first.set([...ascii('Xing'), ...be32(1), ...be32(xingFrames)], 36)
  return bytes(
    [...ascii('ID3'), 4, 0, 0, 0, 0, 0, 10],
    Array<number>(10).fill(0),
    first,
    ...Array.from({ length: frames - 1 }, frame),
  )
}

const oggPage = (granule: number, packet: number[], type = 0) => [
  ...ascii('OggS'),
  0,
  type,
  ...le32(granule),
  ...le32(0),
  ...le32(1),
  ...le32(0),
  ...le32(0),
  1,
  packet.length,
  ...packet,
]

export function oggVorbis(seconds: number, sampleRate = 44100, channels = 2) {
  const id = [
    1,
    ...ascii('vorbis'),
    ...le32(0),
    channels,
    ...le32(sampleRate),
    ...le32(0),
    ...le32(128000),
    ...le32(0),
    0xb8,
    1,
  ]
  return bytes(oggPage(0, id, 2), oggPage(seconds * sampleRate, [0, 1, 2, 3], 4))
}

export function oggOpus(seconds: number, channels = 2) {
  const head = [...ascii('OpusHead'), 1, channels, ...le16(312), ...le32(48000), 0, 0, 0]
  return bytes(oggPage(0, head, 2), oggPage(seconds * 48000 + 312, [0, 1, 2, 3], 4))
}

export function flac(seconds: number, sampleRate = 44100, channels = 2) {
  const total = seconds * sampleRate
  const packed = ((sampleRate << 12) | ((channels - 1) << 9) | (15 << 4)) >>> 0
  return bytes(
    ascii('fLaC'),
    [0x80, 0, 0, 34],
    be16(4096),
    be16(4096),
    [0, 0, 0, 0, 0, 0],
    be32(packed),
    be32(total),
    Array<number>(16).fill(0),
  )
}

const maxp = (glyphs: number) => [...be32(0x00005000), ...be16(glyphs)]

export function ttf(glyphs: number, tag = 'true') {
  const table = maxp(glyphs)
  return bytes(
    tag === 'OTTO' ? ascii('OTTO') : be32(0x00010000),
    be16(1),
    be16(16),
    be16(0),
    be16(0),
    ascii('maxp'),
    be32(0),
    be32(28),
    be32(table.length),
    table,
  )
}

export function woff(glyphs: number, compress: boolean) {
  const table = new Uint8Array([...maxp(glyphs), ...Array<number>(64).fill(0)])
  const stored = compress ? new Uint8Array(deflateSync(table)) : table
  const offset = 44 + 20
  return bytes(
    ascii('wOFF'),
    be32(0x00010000),
    be32(offset + stored.length),
    be16(1),
    be16(0),
    Array<number>(28).fill(0),
    ascii('maxp'),
    be32(offset),
    be32(stored.length),
    be32(table.length),
    be32(0),
    stored,
  )
}

export function mp4(seconds: number, width: number, height: number) {
  const timescale = 1000
  const mvhd = fullBox(
    'mvhd',
    be32(0),
    be32(0),
    be32(timescale),
    be32(seconds * timescale),
    Array<number>(80).fill(0),
  )
  const tkhd = fullBox(
    'tkhd',
    be32(0),
    be32(0),
    be32(1),
    be32(0),
    be32(seconds * timescale),
    Array<number>(8).fill(0),
    Array<number>(8).fill(0),
    Array<number>(36).fill(0),
    be32(width * 65536),
    be32(height * 65536),
  )
  return bytes(
    box('ftyp', ascii('isom'), be32(0), ascii('isom')),
    box('moov', mvhd, box('trak', tkhd)),
  )
}
