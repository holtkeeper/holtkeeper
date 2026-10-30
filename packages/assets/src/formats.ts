import type { AssetKind, AssetMeta } from './data.ts'
import { glbJson, parseFnt, parseJsonAtlas, parseTextAtlas } from './headers/atlas.ts'
import {
  parseFlac,
  parseM4a,
  parseMp3,
  parseMp4Video,
  parseOgg,
  parseWav,
} from './headers/audio.ts'
import { parseFont } from './headers/font.ts'
import {
  parseAvif,
  parseBmp,
  parseGif,
  parseIco,
  parseJpeg,
  parsePng,
  parseSvg,
  parseWebp,
} from './headers/image.ts'

interface Format {
  kind: AssetKind
  /** Text formats get a gzip size and are searched for references to other assets. */
  text?: boolean
  meta?: (bytes: Uint8Array) => AssetMeta | undefined
}

const image = (parse: (bytes: Uint8Array) => AssetMeta['image']) => (bytes: Uint8Array) => {
  const meta = parse(bytes)
  return meta && { image: meta }
}
const audio = (parse: (bytes: Uint8Array) => AssetMeta['audio']) => (bytes: Uint8Array) => {
  const meta = parse(bytes)
  return meta && { audio: meta }
}
const video = (bytes: Uint8Array) => {
  const meta = parseMp4Video(bytes)
  return meta && { video: meta }
}
const font: Format = {
  kind: 'font',
  meta: (bytes) => {
    const meta = parseFont(bytes)
    return meta && { font: meta }
  },
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** Known asset formats by lowercase extension. */
export const formats: Record<string, Format> = {
  png: { kind: 'image', meta: image(parsePng) },
  apng: { kind: 'image', meta: image(parsePng) },
  jpg: { kind: 'image', meta: image(parseJpeg) },
  jpeg: { kind: 'image', meta: image(parseJpeg) },
  gif: { kind: 'image', meta: image(parseGif) },
  webp: { kind: 'image', meta: image(parseWebp) },
  avif: { kind: 'image', meta: image(parseAvif) },
  svg: { kind: 'image', text: true, meta: image(parseSvg) },
  bmp: { kind: 'image', meta: image(parseBmp) },
  ico: { kind: 'image', meta: image(parseIco) },
  ktx: { kind: 'image' },
  ktx2: { kind: 'image' },
  basis: { kind: 'image' },
  dds: { kind: 'image' },
  mp3: { kind: 'audio', meta: audio(parseMp3) },
  ogg: { kind: 'audio', meta: audio(parseOgg) },
  oga: { kind: 'audio', meta: audio(parseOgg) },
  opus: { kind: 'audio', meta: audio(parseOgg) },
  wav: { kind: 'audio', meta: audio(parseWav) },
  flac: { kind: 'audio', meta: audio(parseFlac) },
  m4a: { kind: 'audio', meta: audio(parseM4a) },
  aac: { kind: 'audio' },
  mp4: { kind: 'video', meta: video },
  m4v: { kind: 'video', meta: video },
  webm: { kind: 'video' },
  ttf: font,
  otf: font,
  ttc: font,
  woff: font,
  woff2: font,
  atlas: { kind: 'atlas', text: true, meta: (bytes) => ({ atlas: parseTextAtlas(decode(bytes)) }) },
  fnt: { kind: 'atlas', text: true, meta: (bytes) => ({ atlas: parseFnt(decode(bytes)) }) },
  json: { kind: 'data', text: true },
  skel: { kind: 'data' },
  glb: { kind: 'model' },
  gltf: { kind: 'model', text: true },
  fbx: { kind: 'model' },
  obj: { kind: 'model', text: true },
}

/** Extensions never inventoried even when large: code, styles, documents, source maps. */
export const codeExtensions = new Set([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'vue',
  'svelte',
  'astro',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'map',
  'md',
  'mdx',
  'txt',
  'yml',
  'yaml',
  'toml',
  'xml',
  'lock',
  'd',
])

/** Lowercase extension without the dot, or `''`. */
export const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Kind and header metadata of a file. JSON is an `atlas` when it parses as a sprite atlas and
 * `data` otherwise. Malformed headers yield no metadata rather than an error.
 */
export function describe(path: string, bytes: Uint8Array): { kind: AssetKind; meta: AssetMeta } {
  const format = formats[extensionOf(path)]
  if (!format) return { kind: 'other', meta: {} }
  try {
    if (extensionOf(path) === 'json') {
      const atlas = parseJsonAtlas(JSON.parse(decode(bytes)))
      return atlas ? { kind: 'atlas', meta: { atlas } } : { kind: 'data', meta: {} }
    }
    return { kind: format.kind, meta: format.meta?.(bytes) ?? {} }
  } catch {
    return { kind: format.kind, meta: {} }
  }
}

/** Text that may mention other assets: text formats as they are, the JSON chunk of a `.glb`. */
export function referenceText(path: string, bytes: Uint8Array): string | undefined {
  const extension = extensionOf(path)
  if (extension === 'glb') return glbJson(bytes)
  return formats[extension]?.text ? decode(bytes) : undefined
}

/** Whether the format is text and so worth a gzip size. */
export const isText = (path: string) => formats[extensionOf(path)]?.text === true
