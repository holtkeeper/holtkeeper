import { ConfluenceInputError, MarkerError } from './errors.ts'
import { isBalanced, NBSP } from './xml.ts'

const MARKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/**
 * Throws `ConfluenceInputError` unless `markerId` is empty (the whole page) or 1-64 letters,
 * digits, `.`, `_`, `:` or `-` starting with a letter or digit.
 */
export function assertMarkerId(markerId: string): void {
  if (markerId !== '' && !MARKER_ID.test(markerId))
    throw new ConfluenceInputError(
      `marker id must match ${MARKER_ID.source}, got ${JSON.stringify(markerId)}`,
    )
}

const markerBase = (markerId: string) =>
  markerId.startsWith('holtkeeper:') ? markerId : `holtkeeper:${markerId}`

/**
 * The anchor text of a section's start or end marker: `holtkeeper:<markerId>:start|end`, without
 * doubling a `holtkeeper:` prefix the id already has.
 */
export const markerName = (markerId: string, edge: 'start' | 'end') =>
  `${markerBase(markerId)}:${edge}`

/** A marker as written by this package: an `anchor` macro alone in a paragraph. */
export const renderMarker = (markerId: string, edge: 'start' | 'end') =>
  `<p><ac:structured-macro ac:name="anchor" ac:schema-version="1"><ac:parameter ac:name="">${markerName(markerId, edge)}</ac:parameter></ac:structured-macro></p>`

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface Marker {
  edge: 'start' | 'end'
  /** Bounds including a wrapping paragraph that holds nothing else. */
  from: number
  to: number
}

function findMarkers(body: string, markerId: string): Marker[] {
  const pattern = new RegExp(
    `<ac:structured-macro\\b[^>]*\\bac:name="anchor"[^>]*>\\s*<ac:parameter\\b[^>]*>\\s*${escapeRegExp(markerBase(markerId))}:(start|end)\\s*</ac:parameter>\\s*</ac:structured-macro>`,
    'g',
  )
  const markers: Marker[] = []
  for (const match of body.matchAll(pattern)) {
    let from = match.index
    let to = from + match[0].length
    const before = /<p\b[^>]*>\s*$/.exec(body.slice(Math.max(0, from - 400), from))
    const after = /^\s*<\/p>/.exec(body.slice(to))
    if (before && after) {
      from -= before[0].length
      to += after[0].length
    }
    markers.push({ edge: match[1] === 'start' ? 'start' : 'end', from, to })
  }
  return markers
}

/** Where a section's content sits in a storage body, between its two markers. */
export interface SectionBounds {
  start: number
  end: number
}

/**
 * Finds the section named `markerId`. Returns `undefined` when neither marker exists; throws
 * `MarkerError` when markers are duplicated, unpaired, out of order, or enclose unbalanced markup
 * (a marker moved inside a table cell or list item, for example).
 */
export function findSection(body: string, markerId: string): SectionBounds | undefined {
  const markers = findMarkers(body, markerId)
  if (markers.length === 0) return undefined
  const starts = markers.filter((marker) => marker.edge === 'start')
  const ends = markers.filter((marker) => marker.edge === 'end')
  if (starts.length !== 1 || ends.length !== 1)
    throw new MarkerError(
      `section ${markerId} needs exactly one start and one end marker, found ${starts.length} and ${ends.length}`,
    )
  const start = starts[0]!
  const end = ends[0]!
  if (end.from < start.to)
    throw new MarkerError(`section ${markerId}: the end marker comes before the start marker`)
  const bounds = { start: start.to, end: end.from }
  if (!isBalanced(body.slice(bounds.start, bounds.end)))
    throw new MarkerError(
      `section ${markerId}: markers are not at the same block level; move them back to their own lines`,
    )
  return bounds
}

/**
 * Normalizes storage XHTML for comparison: collapses whitespace, drops whitespace between tags,
 * editor-generated ids (`ac:macro-id`, `local-id`, `ac:local-id`, `ac:schema-version`) and
 * self-closing spacing, and treats `&nbsp;` and `&#160;` alike.
 */
export function normalizeStorage(markup: string): string {
  return markup
    .replaceAll(
      /\s+(?:ac:macro-id|ac:local-id|local-id|ac:schema-version|data-local-id)="[^"]*"/g,
      '',
    )
    .replaceAll(/&nbsp;|&#160;|&#xa0;/gi, NBSP)
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/>\s+</g, '><')
    .replaceAll(/\s*\/>/g, '/>')
    .replaceAll(/<(\w[\w:-]*)([^>]*)><\/\1>/g, (whole, name: string, attrs: string) =>
      ['p', 'span'].includes(name) && attrs === '' ? '' : whole,
    )
    .trim()
}

/** Result of putting new content into a section of a storage body. */
export interface SectionUpdate {
  body: string
  changed: boolean
  /** `true` when the markers were missing and the section was appended. */
  appended: boolean
}

/**
 * Puts `content` (storage XHTML) between the markers of `markerId`, leaving everything outside the
 * markers byte-for-byte untouched; appends a new marked section at the end when there are no
 * markers. An empty `markerId` replaces the whole body. `changed` is `false` when the normalized content equals the current one.
 */
export function replaceSectionInStorage(
  body: string,
  markerId: string,
  content: string,
): SectionUpdate {
  assertMarkerId(markerId)
  if (content.includes(`${markerBase(markerId)}:`))
    throw new ConfluenceInputError(`content must not contain the markers of section ${markerId}`)
  if (!isBalanced(content))
    throw new ConfluenceInputError('content is not well-formed storage XHTML')
  if (markerId === '')
    return {
      body: content,
      changed: normalizeStorage(body) !== normalizeStorage(content),
      appended: false,
    }
  const bounds = findSection(body, markerId)
  if (!bounds) {
    return {
      body: `${body}${renderMarker(markerId, 'start')}${content}${renderMarker(markerId, 'end')}`,
      changed: true,
      appended: true,
    }
  }
  const current = body.slice(bounds.start, bounds.end)
  if (normalizeStorage(current) === normalizeStorage(content))
    return { body, changed: false, appended: false }
  return {
    body: body.slice(0, bounds.start) + content + body.slice(bounds.end),
    changed: true,
    appended: false,
  }
}
