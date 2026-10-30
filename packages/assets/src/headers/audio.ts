import type { AudioMeta, VideoMeta } from '../data.ts'
import { type Reader, boxes, indexOfAscii, reader } from './bytes.ts'

const round = (value: number) => Math.round(value)

/** Format, rate, channels and duration from the `fmt ` and `data` chunks of a WAV. */
export function parseWav(bytes: Uint8Array): AudioMeta | undefined {
  const read = reader(bytes)
  if (read.ascii(0, 4) !== 'RIFF' || read.ascii(8, 4) !== 'WAVE') return undefined
  let at = 12
  let format: { code: number; channels: number; sampleRate: number; byteRate: number } | undefined
  let dataBytes: number | undefined
  while (at + 8 <= read.length) {
    const type = read.ascii(at, 4)
    const size = read.u32(at + 4, true) ?? 0
    if (type === 'fmt ') {
      format = {
        code: read.u16(at + 8, true) ?? 0,
        channels: read.u16(at + 10, true) ?? 0,
        sampleRate: read.u32(at + 12, true) ?? 0,
        byteRate: read.u32(at + 16, true) ?? 0,
      }
    }
    if (type === 'data') {
      dataBytes = Math.min(size, read.length - at - 8)
      break
    }
    at += 8 + size + (size % 2)
  }
  if (!format) return undefined
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitrate: format.byteRate * 8,
    codec: format.code === 1 || format.code === 0xfffe ? 'pcm' : `wav-${format.code}`,
    ...(dataBytes !== undefined && format.byteRate
      ? { durationMs: round((dataBytes / format.byteRate) * 1000) }
      : {}),
  }
}

const mp3Bitrates = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const mp3SampleRates: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
}

function id3Size(read: Reader): number {
  if (read.ascii(0, 3) !== 'ID3') return 0
  const size =
    (((read.u8(6) ?? 0) & 0x7f) << 21) |
    (((read.u8(7) ?? 0) & 0x7f) << 14) |
    (((read.u8(8) ?? 0) & 0x7f) << 7) |
    ((read.u8(9) ?? 0) & 0x7f)
  const footer = ((read.u8(5) ?? 0) & 0x10) !== 0
  return 10 + size + (footer ? 10 : 0)
}

/**
 * Rate, channels, bitrate and duration of an MPEG layer III file from its first frame header.
 * Duration comes from a Xing/Info or VBRI frame count when present, otherwise from the file size
 * at the first frame's bitrate (exact for constant bitrate).
 */
export function parseMp3(bytes: Uint8Array): AudioMeta | undefined {
  const read = reader(bytes)
  let at = id3Size(read)
  const limit = Math.min(read.length - 4, at + 64 * 1024)
  while (at < limit && !(read.u8(at) === 0xff && ((read.u8(at + 1) ?? 0) & 0xe0) === 0xe0)) at++
  const header = read.u32(at)
  if (header === undefined || at >= limit) return undefined
  const version = (header >>> 19) & 3
  const layer = (header >>> 17) & 3
  const bitrateIndex = (header >>> 12) & 15
  const rateIndex = (header >>> 10) & 3
  const mode = (header >>> 6) & 3
  if (version === 1 || layer !== 1 || bitrateIndex === 15 || rateIndex === 3) return undefined
  const sampleRate = mp3SampleRates[version]?.[rateIndex] ?? 0
  const frameKbps = (version === 3 ? mp3Bitrates.v1 : mp3Bitrates.v2)[bitrateIndex] ?? 0
  const channels = mode === 3 ? 1 : 2
  const samplesPerFrame = version === 3 ? 1152 : 576
  const sideInfo = version === 3 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17
  const xing = at + 4 + sideInfo
  const tag = read.ascii(xing, 4)
  let frames: number | undefined
  if ((tag === 'Xing' || tag === 'Info') && ((read.u32(xing + 4) ?? 0) & 1) === 1) {
    frames = read.u32(xing + 8)
  } else if (read.ascii(at + 36, 4) === 'VBRI') {
    frames = read.u32(at + 36 + 14)
  }
  const audioBytes = read.length - at - (read.ascii(read.length - 128, 3) === 'TAG' ? 128 : 0)
  let durationMs: number | undefined
  if (frames && sampleRate) durationMs = round(((frames * samplesPerFrame) / sampleRate) * 1000)
  else if (frameKbps) durationMs = round((audioBytes * 8) / frameKbps)
  return {
    sampleRate,
    channels,
    codec: 'mp3',
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(durationMs
      ? { bitrate: round((audioBytes * 8 * 1000) / durationMs) }
      : frameKbps
        ? { bitrate: frameKbps * 1000 }
        : {}),
  }
}

/** Granule position of the last page, read from the end of an Ogg stream. */
function lastGranule(bytes: Uint8Array): number | undefined {
  const read = reader(bytes)
  for (let at = read.length - 27; at >= Math.max(0, read.length - 128 * 1024); at--) {
    if (bytes[at] === 0x4f && read.ascii(at, 4) === 'OggS') {
      const low = read.u32(at + 6, true) ?? 0
      const high = read.u32(at + 10, true) ?? 0
      return high * 2 ** 32 + low
    }
  }
  return undefined
}

/** Codec, rate, channels and duration (last granule position) of Ogg Vorbis or Opus. */
export function parseOgg(bytes: Uint8Array): AudioMeta | undefined {
  const read = reader(bytes)
  if (read.ascii(0, 4) !== 'OggS') return undefined
  const segments = read.u8(26) ?? 0
  const packet = 27 + segments
  let codec: string
  let sampleRate: number
  let channels: number
  let granuleRate: number
  let skip = 0
  if (read.u8(packet) === 1 && read.ascii(packet + 1, 6) === 'vorbis') {
    codec = 'vorbis'
    channels = read.u8(packet + 11) ?? 0
    sampleRate = read.u32(packet + 12, true) ?? 0
    granuleRate = sampleRate
  } else if (read.ascii(packet, 8) === 'OpusHead') {
    codec = 'opus'
    channels = read.u8(packet + 9) ?? 0
    skip = read.u16(packet + 10, true) ?? 0
    sampleRate = read.u32(packet + 12, true) || 48000
    granuleRate = 48000
  } else {
    return undefined
  }
  const granule = lastGranule(bytes)
  const durationMs =
    granule && granuleRate ? round((Math.max(0, granule - skip) / granuleRate) * 1000) : undefined
  return {
    codec,
    sampleRate,
    channels,
    ...(durationMs ? { durationMs, bitrate: round((read.length * 8 * 1000) / durationMs) } : {}),
  }
}

/** Rate, channels, bit depth and duration from the STREAMINFO block of a FLAC. */
export function parseFlac(bytes: Uint8Array): AudioMeta | undefined {
  const read = reader(bytes)
  if (read.ascii(0, 4) !== 'fLaC' || ((read.u8(4) ?? 1) & 0x7f) !== 0) return undefined
  const info = 8
  const packed = read.u32(info + 10)
  const totalLow = read.u32(info + 14)
  if (packed === undefined || totalLow === undefined) return undefined
  const sampleRate = packed >>> 12
  const channels = ((packed >>> 9) & 7) + 1
  const total = (packed & 0xf) * 2 ** 32 + totalLow
  const durationMs = sampleRate && total ? round((total / sampleRate) * 1000) : undefined
  return {
    codec: 'flac',
    sampleRate,
    channels,
    ...(durationMs ? { durationMs, bitrate: round((read.length * 8 * 1000) / durationMs) } : {}),
  }
}

interface Mp4Info {
  durationMs?: number
  width?: number
  height?: number
  audio?: { sampleRate?: number; channels?: number; codec?: string }
}

/** Duration (`mvhd`), largest track size (`tkhd`) and first audio sample entry of an MP4. */
function parseMp4(bytes: Uint8Array): Mp4Info | undefined {
  const read = reader(bytes)
  const top = boxes(read, 0, read.length)
  if (top[0]?.type !== 'ftyp') return undefined
  const moov = top.find((box) => box.type === 'moov')
  if (!moov) return {}
  const info: Mp4Info = {}
  for (const box of boxes(read, moov.body, moov.end)) {
    if (box.type === 'mvhd') {
      const v1 = read.u8(box.body) === 1
      const scale = read.u32(box.body + (v1 ? 20 : 12)) ?? 0
      const duration = v1 ? read.u64(box.body + 24) : read.u32(box.body + 16)
      if (scale && duration) info.durationMs = round((duration / scale) * 1000)
    }
    if (box.type !== 'trak') continue
    const tkhd = boxes(read, box.body, box.end).find((child) => child.type === 'tkhd')
    if (tkhd) {
      const offset = tkhd.body + (read.u8(tkhd.body) === 1 ? 88 : 76)
      const width = (read.u32(offset) ?? 0) / 65536
      const height = (read.u32(offset + 4) ?? 0) / 65536
      if (width * height > (info.width ?? 0) * (info.height ?? 0)) {
        info.width = round(width)
        info.height = round(height)
      }
    }
    const mp4a = indexOfAscii(bytes, 'mp4a', box.body, box.end)
    if (!info.audio && mp4a !== -1) {
      info.audio = {
        codec: 'aac',
        channels: read.u16(mp4a + 4 + 16) ?? 0,
        sampleRate: read.u16(mp4a + 4 + 24) ?? 0,
      }
    }
  }
  return info
}

/** Audio metadata of an M4A/MP4 audio file. */
export function parseM4a(bytes: Uint8Array): AudioMeta | undefined {
  const info = parseMp4(bytes)
  if (!info) return undefined
  return {
    ...info.audio,
    ...(info.durationMs
      ? { durationMs: info.durationMs, bitrate: round((bytes.length * 8 * 1000) / info.durationMs) }
      : {}),
  }
}

/** Video metadata of an MP4. */
export function parseMp4Video(bytes: Uint8Array): VideoMeta | undefined {
  const info = parseMp4(bytes)
  if (!info) return undefined
  return {
    ...(info.durationMs ? { durationMs: info.durationMs } : {}),
    ...(info.width ? { width: info.width, height: info.height ?? 0 } : {}),
  }
}
