/**
 * Path patterns and the folder tree. A repository path's every prefix is a folder; nothing about
 * folders is stored. Patterns are globs over the path (`Bun.Glob` syntax, matched by `globMatches`), optionally forge-qualified
 * (`work:acme/**`). This module has no dependencies so the web app can import it as
 * `@holtkeeper/access/paths`.
 */

/** A pattern split into its forge (absent: every forge) and its glob. */
export interface PathPattern {
  forge?: string
  glob: string
}

/** Splits `forge:glob`; a pattern without a forge prefix matches every forge. */
export function splitPattern(pattern: string): PathPattern {
  const separator = pattern.indexOf(':')
  return separator > 0
    ? { forge: pattern.slice(0, separator), glob: pattern.slice(separator + 1) }
    : { glob: pattern }
}

const WILDCARD = /[*?[\]{}]/

/** Whether `glob` (or one segment of it) holds glob syntax rather than literal text. */
export const hasWildcard = (glob: string): boolean => WILDCARD.test(glob)

/** Expands the first top-level `{a,b}` of `glob`, recursively: `x{a,b}` → `['xa', 'xb']`. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{')
  if (open === -1) return [glob]
  let depth = 0
  const commas: number[] = []
  for (let index = open; index < glob.length; index++) {
    const char = glob[index]
    if (char === '{') depth++
    else if (char === ',' && depth === 1) commas.push(index)
    else if (char === '}' && --depth === 0) {
      const bounds = [open, ...commas, index]
      const head = glob.slice(0, open)
      const tail = glob.slice(index + 1)
      return bounds
        .slice(0, -1)
        .flatMap((start, at) =>
          expandBraces(`${head}${glob.slice(start + 1, bounds[at + 1])}${tail}`),
        )
    }
  }
  return [glob]
}

const escapeChar = (char: string) => (/[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char)

function segmentSource(segment: string): string {
  let source = ''
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] ?? ''
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '[') {
      const close = segment.indexOf(']', index + 2)
      if (close === -1) {
        source += escapeChar(char)
        continue
      }
      let body = segment.slice(index + 1, close)
      const negated = body.startsWith('!') || body.startsWith('^')
      if (negated) body = body.slice(1)
      source += `[${negated ? '^/' : ''}${body.replaceAll('\\', '\\\\')}]`
      index = close
    } else source += escapeChar(char)
  }
  return source
}

function globSource(glob: string): string {
  const segments = glob.split('/').filter((segment) => segment !== '')
  let source = ''
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') source += last ? '[^/]+(?:/[^/]+)*' : '(?:[^/]+/)*'
    else source += segmentSource(segment) + (last ? '' : '/')
  })
  return source
}

const compiled = new Map<string, RegExp>()

/**
 * Whether `glob` matches the repository `path`, the way `Bun.Glob` does for repository paths:
 * `*` and `?` stay within a segment, `**` spans any number of segments (a trailing one at least
 * one), `[...]` and `{a,b}` work as usual. Pure JavaScript, so it also runs in the browser.
 */
export function globMatches(glob: string, path: string): boolean {
  let regex = compiled.get(glob)
  if (!regex) {
    regex = new RegExp(`^(?:${expandBraces(glob).map(globSource).join('|')})$`)
    compiled.set(glob, regex)
  }
  return regex.test(path)
}

/** Whether the pattern matches the repository at `path` on `forge`. */
export function patternMatches(pattern: string, forge: string, path: string): boolean {
  const split = splitPattern(pattern)
  return (split.forge === undefined || split.forge === forge) && globMatches(split.glob, path)
}

const segmentsOf = (glob: string) => glob.split('/').filter((segment) => segment !== '')

function segmentWithin(inner: string, outer: string): boolean {
  if (outer === '*') return inner !== '**'
  if (inner === outer) return true
  if (hasWildcard(inner)) return false
  return hasWildcard(outer) && globMatches(outer, inner)
}

function segmentsWithin(inner: readonly string[], outer: readonly string[]): boolean {
  const [head, ...rest] = outer
  if (head === undefined) return inner.length === 0
  if (head === '**') {
    // Like Bun.Glob, a trailing `**` needs at least one segment (`a/**` does not match `a`), while
    // one followed by more segments may match none (`**\/c` matches `c`).
    if (rest.length === 0) return inner.length > 0
    if (segmentsWithin(inner, rest)) return true
    return inner.length > 0 && segmentsWithin(inner.slice(1), outer)
  }
  const [first, ...others] = inner
  if (first === undefined || first === '**') return false
  return segmentWithin(first, head) && segmentsWithin(others, rest)
}

/**
 * Whether every path `inner` can match is also matched by `outer`, segment by segment: `*` is one
 * segment, `**` any number. Exact for patterns built from literal segments, `*` and `**`; a
 * segment with a partial wildcard (`app-*`, `{a,b}`) is only within an equal segment or one that
 * matches it literally, so the answer can be too strict but never too generous.
 */
export function patternWithin(inner: string, outer: string): boolean {
  const a = splitPattern(inner)
  const b = splitPattern(outer)
  if (b.forge !== undefined && a.forge !== b.forge) return false
  if (a.glob === b.glob) return true
  return segmentsWithin(segmentsOf(a.glob), segmentsOf(b.glob))
}

/** How many leading segments of the pattern's glob are literal: the folder depth it pins. */
export function literalDepth(pattern: string): number {
  let depth = 0
  for (const segment of segmentsOf(splitPattern(pattern).glob)) {
    if (hasWildcard(segment)) break
    depth++
  }
  return depth
}

/** Whether the pattern names exactly one path (no glob syntax). */
export const isExactPattern = (pattern: string): boolean => !hasWildcard(splitPattern(pattern).glob)

/** The folders holding `path`, deepest first: `a/b/c` → `['a/b', 'a']`. */
export function pathAncestors(path: string): string[] {
  const segments = segmentsOf(path)
  const folders: string[] = []
  for (let end = segments.length - 1; end > 0; end--) folders.push(segments.slice(0, end).join('/'))
  return folders
}

/** The folder directly holding `path`, or `undefined` for a path at the root. */
export const parentFolder = (path: string): string | undefined => pathAncestors(path)[0]

/** The deepest folder holding every path, or `undefined` when they share none. */
export function commonFolder(paths: readonly string[]): string | undefined {
  const [first] = paths
  if (first === undefined) return undefined
  return pathAncestors(first).find((folder) => paths.every((path) => path.startsWith(`${folder}/`)))
}

/**
 * The pattern of a folder and everything under it, forge-qualified when `forge` is given:
 * `folderPattern('acme/round', 'work')` → `work:acme/round/**`.
 */
export const folderPattern = (folder: string, forge?: string): string =>
  `${forge ? `${forge}:` : ''}${folder}/**`

/**
 * One pattern for paths of the same length that differ in exactly one segment, with `*` there:
 * `['a/x/c', 'a/y/c']` → `a/*\/c`. `undefined` for a single path or any other shape.
 */
export function sharedShape(paths: readonly string[]): string | undefined {
  const split = [...new Set(paths)].map(segmentsOf)
  const [first] = split
  if (!first || split.length < 2 || split.some((s) => s.length !== first.length)) return undefined
  const differing = first
    .map((_, index) => index)
    .filter((index) => split.some((segments) => segments[index] !== first[index]))
  if (differing.length !== 1) return undefined
  return first.map((segment, index) => (index === differing[0] ? '*' : segment)).join('/')
}
