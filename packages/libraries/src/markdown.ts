import type { LibraryChunk, LibraryRef } from '@holtkeeper/store'

/** One section of a Markdown document, ready to become a `LibraryChunk`. */
export interface MarkdownChunk {
  /** Heading path from the document title down to the section; empty for text before any heading. */
  headings: string[]
  /** GitHub slug of the last heading, unique within the document. */
  anchor?: string
  text: string
}

/** Default upper bound of a chunk's text. */
export const chunkChars = 1500

const fenceOf = (line: string) => /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]

/** Heading text without trailing `#`s, link targets, emphasis and HTML tags. */
export function cleanHeading(title: string): string {
  return title
    .replace(/\s+#+\s*$/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .trim()
}

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens. */
export function slug(title: string): string {
  return cleanHeading(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

const VERSION = /(?:^|[\s[(v@/])v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)(?=$|[\s\])—–:,/])/

/** The first version-like token of a heading without a `v` prefix, e.g. `2.1.0` for `[v2.1.0] - 2024-05-01`. */
export function headingVersion(title: string): string | undefined {
  return VERSION.exec(title)?.[1]
}

/** Major versions a heading names, e.g. `[3, 4]` for `Migrating from v3 to v4`. */
export function headingMajors(title: string): number[] {
  return [...title.matchAll(/\bv?(\d+)(?:\.(?:\d+|x))*\b/g)].map((match) => Number(match[1]))
}

const splitUnits = (lines: string[]): string[] => {
  const units: string[] = []
  let current: string[] = []
  let fence: string | undefined
  const flush = () => {
    if (current.length) units.push(current.join('\n'))
    current = []
  }
  for (const line of lines) {
    const marker = fenceOf(line)
    if (fence === undefined && marker) {
      flush()
      fence = marker
      current.push(line)
      continue
    }
    if (fence !== undefined) {
      current.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined
        flush()
      }
      continue
    }
    if (!line.trim()) flush()
    else current.push(line)
  }
  flush()
  return units
}

const hardSplit = (text: string, max: number): string[] => {
  const pieces: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    for (let start = 0; start < Math.max(line.length, 1); start += max) {
      const part = line.slice(start, start + max)
      if (current && current.length + part.length + 1 > max) {
        pieces.push(current)
        current = ''
      }
      current = current ? `${current}\n${part}` : part
    }
  }
  if (current.trim()) pieces.push(current)
  return pieces
}

const pack = (lines: string[], max: number): string[] => {
  const text = lines.join('\n').trim()
  if (text.length <= max) return text ? [text] : []
  const pieces: string[] = []
  let current = ''
  for (const unit of splitUnits(lines)) {
    for (const part of unit.length > max ? hardSplit(unit, max) : [unit]) {
      if (current && current.length + part.length + 2 > max) {
        pieces.push(current)
        current = ''
      }
      current = current ? `${current}\n\n${part}` : part
    }
  }
  if (current.trim()) pieces.push(current)
  return pieces
}

/**
 * Splits Markdown by ATX heading into sections of at most `max` characters (longer sections are
 * split between paragraphs, never inside a code fence unless the fence alone is too long). Each
 * section keeps its heading path; sections that hold only their heading are left out.
 */
export function chunkMarkdown(markdown: string, max = chunkChars): MarkdownChunk[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const chunks: MarkdownChunk[] = []
  const stack: { level: number; title: string }[] = []
  const anchors = new Map<string, number>()
  let anchor: string | undefined
  let body: string[] = []
  let headingLine = false
  let fence: string | undefined

  const flush = () => {
    const hasBody = body.slice(headingLine ? 1 : 0).some((line) => line.trim())
    if (hasBody) {
      const headings = stack.map((item) => item.title)
      for (const text of pack(body, max))
        chunks.push({ headings, ...(anchor ? { anchor } : {}), text })
    }
    body = []
  }

  for (const line of lines) {
    const marker = fenceOf(line)
    if (fence !== undefined) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      body.push(line)
      continue
    }
    if (marker) {
      fence = marker
      body.push(line)
      continue
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (heading?.[1] && heading[2] !== undefined) {
      flush()
      const level = heading[1].length
      while (stack.length && (stack.at(-1)?.level ?? 0) >= level) stack.pop()
      const title = cleanHeading(heading[2])
      stack.push({ level, title })
      const base = slug(title)
      const seen = anchors.get(base) ?? 0
      anchors.set(base, seen + 1)
      anchor = seen ? `${base}-${seen}` : base
      headingLine = true
      body.push(line)
      continue
    }
    body.push(line)
  }
  flush()
  return chunks
}

/** Stable chunk id: SHA-256 over the library, source, path, heading path and text. */
export function chunkId(
  ref: LibraryRef,
  source: LibraryChunk['source'],
  path: string,
  headings: readonly string[],
  text: string,
): string {
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify([ref.ecosystem, ref.name, source, path, headings, text]))
    .digest('hex')
}

/**
 * `chunkMarkdown` of one file as store chunks, without duplicate ids. `url` gets the anchor
 * appended as `#anchor` when it has one.
 */
export function documentChunks(
  ref: LibraryRef,
  source: LibraryChunk['source'],
  path: string,
  markdown: string,
  options: { url?: string; prefix?: string[]; max?: number } = {},
): Omit<LibraryChunk, 'versions'>[] {
  const seen = new Set<string>()
  const out: Omit<LibraryChunk, 'versions'>[] = []
  for (const chunk of chunkMarkdown(markdown, options.max)) {
    const headings = [...(options.prefix ?? []), ...chunk.headings]
    const id = chunkId(ref, source, path, headings, chunk.text)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      ...ref,
      id,
      source,
      path,
      headings,
      ...(chunk.anchor ? { anchor: chunk.anchor } : {}),
      text: chunk.text,
      ...(options.url
        ? { url: chunk.anchor ? `${options.url}#${chunk.anchor}` : options.url }
        : {}),
    })
  }
  return out
}
