import type { AssetKind } from './data.ts'

const kinds: Record<string, AssetKind> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  css: 'css',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  avif: 'image',
  ico: 'image',
  bmp: 'image',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  eot: 'font',
}

/** Kind of an asset by its extension; unknown extensions are `other`. */
export function assetKind(file: string): AssetKind {
  const dot = file.lastIndexOf('.')
  return (dot === -1 ? undefined : kinds[file.slice(dot + 1).toLowerCase()]) ?? 'other'
}

const looksLikeHash = (token: string) =>
  /^[0-9a-f]{8,}$/i.test(token) ||
  (token.length >= 6 &&
    /[A-Za-z]/.test(token) &&
    (/\d/.test(token) || /[A-Z].*[a-z]|[a-z].*[A-Z]/.test(token)))

const strict = (token: string) => looksLikeHash(token.replaceAll(/[-_]/g, ''))

function strip(file: string, isHash: (token: string) => boolean, removed?: string[]): string {
  const slash = file.lastIndexOf('/')
  const dir = file.slice(0, slash + 1)
  const base = file.slice(slash + 1)
  const extStart = base.indexOf('.', 1)
  if (extStart === -1) return file
  let stem = base.slice(0, extStart)

  // `name.hash.ext` puts the hash among the extensions.
  const parts = base.slice(extStart + 1).split('.')
  const kept = parts.filter((part, index) => {
    const hash = index < parts.length - 1 && isHash(part)
    if (hash) removed?.push(part)
    return !hash
  })

  for (;;) {
    const match = [
      /[-.~]([A-Za-z0-9_-]{8})$/.exec(stem),
      /[-.~]([A-Za-z0-9_]{6,})$/.exec(stem),
    ].find((candidate) => candidate?.[1] && isHash(candidate[1]))
    if (!match?.[1]) break
    removed?.push(match[1])
    stem = stem.slice(0, match.index)
  }
  if (stem.length >= 8 && looksLikeHash(stem)) {
    removed?.push(stem)
    stem = 'chunk'
  }
  return `${dir}${stem}.${kept.join('.')}`
}

/**
 * Removes content hashes from a file path so the same asset matches across builds:
 * `assets/index-B3x9kQz1.js` → `assets/index.js`, `main.3f2a1b9c.css` → `main.css`. A token counts
 * as a hash when it follows `-` or `.`, and is 8+ hex characters, or 6+ characters with letters and
 * digits or mixed case. Plain words such as `vendor` or `polyfill` are kept.
 */
export function normalizeAssetName(file: string): string {
  return strip(file, strict)
}

const codeKinds = new Set<AssetKind>(['js', 'css'])

const extension = (file: string) => file.slice(file.lastIndexOf('.') + 1).toLowerCase()

const wordShaped = (token: string) =>
  /[aeiouy]/i.test(token) && !/[b-df-hj-np-tv-xz]{4}/i.test(token)

function repeatedStemHashes(files: readonly string[]): { tokens: string[]; files: string[] }[] {
  const groups = new Map<string, { tokens: Set<string>; files: string[] }>()
  for (const file of files) {
    if (!codeKinds.has(assetKind(file))) continue
    const slash = file.lastIndexOf('/')
    const base = file.slice(slash + 1)
    const extStart = base.indexOf('.', 1)
    if (extStart === -1) continue
    const match = /[-.~]([A-Za-z0-9_]{8,})$/.exec(base.slice(0, extStart))
    if (!match?.[1]) continue
    const key = `${file.slice(0, slash + 1)}${base.slice(0, match.index + 1)}${base.slice(extStart)}`
    const group = groups.get(key) ?? { tokens: new Set<string>(), files: [] }
    group.tokens.add(match[1])
    group.files.push(file)
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((group) => ({ tokens: [...group.tokens], files: group.files }))
    .filter(({ tokens }) => {
      const length = tokens[0]?.length
      return (
        tokens.length >= 2 &&
        tokens.every((token) => token.length === length) &&
        (tokens.every((token) => /^[0-9a-z]+$/.test(token)) ||
          tokens.every((token) => /^[0-9A-Z]+$/.test(token))) &&
        tokens.some((token) => /\d/.test(token) || !wordShaped(token))
      )
    })
}

/**
 * `normalizeAssetName` for a whole build. Hashes without digits or mixed case (`chunk-rkgagbvp.js`)
 * look like words to a single-file check, so the build supplies more evidence: one stem in one
 * directory repeated with two or more different single-case JS or CSS tokens of the same length, 8 or
 * more characters each, at least one of which has a digit or does not read like a word (no vowel, or
 * four consonants in a row), marks those tokens as hashes: `chunk-rkgagbvp.js` and
 * `chunk-mnbvcxzq.js` do, `locale-german.js` and `locale-french.js` do not. The length and alphabet
 * of every hash found (one is enough) are then learned and applied to the remaining files with an
 * extension that carried a hash, so a word is stripped only when it has exactly the length and
 * alphabet of a hash on the same file type in the same build.
 */
export function normalizeAssetNames(files: readonly string[]): Map<string, string> {
  const removed: string[] = []
  const hashed = new Set<string>()
  for (const file of files) {
    const before = removed.length
    strip(file, strict, removed)
    if (removed.length > before) hashed.add(extension(file))
  }
  for (const group of repeatedStemHashes(files)) {
    removed.push(...group.tokens)
    for (const file of group.files) hashed.add(extension(file))
  }
  const lengths = new Set(removed.map((token) => token.length))
  const alphabet = [/^[0-9a-f]+$/, /^[0-9a-z]+$/, /^[0-9A-Z]+$/, /^[0-9A-Za-z_-]+$/].find(
    (pattern) => removed.every((token) => pattern.test(token)),
  )
  const learned = (token: string) =>
    strict(token) || (alphabet !== undefined && lengths.has(token.length) && alphabet.test(token))
  return new Map(
    files.map((file) => [file, strip(file, hashed.has(extension(file)) ? learned : strict)]),
  )
}
