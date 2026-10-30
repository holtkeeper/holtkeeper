import { realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { type FileAccess, diskFiles, offsetOf } from '@holtkeeper/changes'
import type { Position, Range } from '@holtkeeper/changes'

/** A file's text with its lines, for converting tool locations into `Range`s. */
export interface SourceText {
  text: string
  lines: string[]
}

/** Reads analyzed files relative to the project directory, each at most once. */
export interface SourceReader {
  read(file: string): Promise<SourceText | undefined>
}

/** A `SourceReader` over `files` (the checkout on disk by default) that caches every read. */
export function sourceReader(dir: string, files: FileAccess = diskFiles(dir)): SourceReader {
  const cache = new Map<string, Promise<SourceText | undefined>>()
  return {
    read(file) {
      let entry = cache.get(file)
      if (!entry) {
        entry = files
          .read(file)
          .then((text) => (text === undefined ? undefined : { text, lines: text.split('\n') }))
          .catch(() => undefined)
        cache.set(file, entry)
      }
      return entry
    },
  }
}

/** 1-based position of a UTF-16 offset. */
export function positionAt(text: string, offset: number): Position {
  let line = 1
  let lineStart = 0
  for (
    let index = text.indexOf('\n');
    index !== -1 && index < offset;
    index = text.indexOf('\n', index + 1)
  ) {
    line++
    lineStart = index + 1
  }
  return { line, column: offset - lineStart + 1 }
}

/** UTF-16 index of the `count`-th code point of `text`, starting at `from`. */
export function codePointsToUnits(text: string, count: number, from = 0): number {
  let index = from
  let seen = 0
  while (seen < count && index < text.length) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1
    seen++
  }
  return index + count - seen
}

/** The text a range covers, or `undefined` when it lies outside the file. */
export function textIn(source: SourceText, range: Range): string | undefined {
  const start = offsetOf(source.text, range.start)
  const end = offsetOf(source.text, range.end)
  if (start === undefined || end === undefined || end < start) return undefined
  return source.text.slice(start, end)
}

/** Length of a line without its `\r`, in UTF-16 units. */
export function lineLength(source: SourceText, line: number): number {
  const text = source.lines[line - 1] ?? ''
  return text.endsWith('\r') ? text.length - 1 : text.length
}

const toPosix = (path: string) => path.split(sep).join('/')

/** Maps paths a tool printed (absolute, relative or `file:` URLs) to forward-slash paths relative to `dir`. */
export interface PathResolver {
  /** `base` is a directory the path is relative to, itself absolute or relative to `dir`. */
  relative(path: string, base?: string): string
}

/**
 * Resolves against `dir` and its real path, so tools that print canonical paths (macOS
 * `/private/var/...` for `/var/...`) still map inside the project.
 */
export async function pathResolver(dir: string): Promise<PathResolver> {
  const root = resolve(dir)
  const real = await realpath(root).catch(() => root)
  return {
    relative(path, base = '') {
      const absolute = resolve(root, base, path)
      const fromRoot = relative(root, absolute)
      if (!fromRoot.startsWith('..') || real === root) return toPosix(fromRoot)
      const fromReal = relative(real, absolute)
      return toPosix(fromReal.startsWith('..') ? fromRoot : fromReal)
    },
  }
}
