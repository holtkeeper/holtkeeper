import { knowledgeWords } from './knowledge.ts'
import type {
  LibraryChunk,
  LibraryChunkFilter,
  LibraryIssue,
  LibraryRecord,
  LibraryRef,
  LibraryStats,
  LibraryStore,
  LibraryVersionRecord,
} from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]*)?$/

const comparePrerelease = (a: string, b: string): number => {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const diff = Number(x) - Number(y)
      if (diff) return diff
    } else if (xn !== yn) return xn ? -1 : 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Orders version strings by semantic version, lowest first: `1.9.0` < `1.10.0`, a prerelease
 * below its release, a leading `v` (Go) and build metadata ignored. Strings that are not
 * versions sort below every version, among themselves by code unit; equal versions spelled
 * differently fall back to the same order, so the result is total.
 */
export function compareLibraryVersions(a: string, b: string): number {
  const x = VERSION.exec(a)
  const y = VERSION.exec(b)
  if (!x || !y) {
    if (x || y) return x ? 1 : -1
    return a < b ? -1 : a > b ? 1 : 0
  }
  for (const i of [1, 2, 3]) {
    const diff = Number(x[i] ?? 0) - Number(y[i] ?? 0)
    if (diff) return diff
  }
  const pre =
    x[4] === undefined
      ? y[4] === undefined
        ? 0
        : 1
      : y[4] === undefined
        ? -1
        : comparePrerelease(x[4], y[4])
  if (pre) return pre
  return a < b ? -1 : a > b ? 1 : 0
}

/** `versions` sorted highest semantic version first, without duplicates. */
export const newestVersionsFirst = (versions: Iterable<string>): string[] =>
  [...new Set(versions)].toSorted((a, b) => compareLibraryVersions(b, a))

/**
 * Search terms of a library search text: words (lowercase letters, digits, `_`) as
 * one-element lists, and quoted phrases of two or more words as their word lists. A phrase of
 * one word is a plain word; an unclosed quote is plain text. Duplicates are dropped.
 */
export function libraryQueryTerms(text: string): string[][] {
  const parts = text.split('"')
  const unclosed = parts.length % 2 === 0
  const terms = new Map<string, string[]>()
  parts.forEach((part, i) => {
    const words = knowledgeWords(part)
    const phrase = i % 2 === 1 && !(unclosed && i === parts.length - 1) && words.length > 1
    for (const term of phrase ? [words] : words.map((word) => [word]))
      terms.set(term.join(' '), term)
  })
  return [...terms.values()]
}

const sameLibrary = (a: LibraryRef, b: LibraryRef) =>
  a.ecosystem === b.ecosystem && a.name === b.name

const libraryKey = (ref: LibraryRef) => `${ref.ecosystem}\u0000${ref.name}`

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Weighted matches of query terms in fields: prefix for words, exact consecutive words for phrases. */
function termScore(terms: string[][], fields: [weight: number, text: string][]): number {
  const words = fields.map(([weight, text]) => [weight, knowledgeWords(text)] as const)
  let score = 0
  for (const term of terms) {
    for (const [weight, list] of words) {
      let hits = 0
      if (term.length === 1) hits = list.filter((word) => word.startsWith(term[0]!)).length
      else
        for (let i = 0; i + term.length <= list.length; i++)
          if (term.every((word, j) => list[i + j] === word)) hits++
      if (hits) score += (weight * hits) / (hits + 1)
    }
  }
  return score
}

/** Text of an issue's digest as the stores index it. */
export const libraryIssueDigestText = (issue: LibraryIssue): string =>
  issue.digest
    ? [
        issue.digest.problem,
        ...issue.digest.symptoms,
        issue.digest.affected,
        issue.digest.fixedIn,
        issue.digest.workaround,
      ]
        .filter((part) => part !== undefined)
        .join('\n')
    : ''

/** Text of an issue's first message and answer as the stores index it. */
export const libraryIssueBodyText = (issue: LibraryIssue): string =>
  [issue.body, issue.answer].filter((part) => part !== undefined).join('\n')

/** The fields of a chunk without `versions`, copied, optional fields absent when unset. */
export const plainChunk = (
  chunk: Omit<LibraryChunk, 'versions'>,
): Omit<LibraryChunk, 'versions'> => ({
  ecosystem: chunk.ecosystem,
  name: chunk.name,
  id: chunk.id,
  source: chunk.source,
  path: chunk.path,
  headings: [...chunk.headings],
  ...(chunk.anchor !== undefined && { anchor: chunk.anchor }),
  text: chunk.text,
  ...(chunk.url !== undefined && { url: chunk.url }),
})

interface StoredChunk {
  chunk: Omit<LibraryChunk, 'versions'>
  versions: Set<string>
  position: number
}

/** The in-memory `LibraryStore`; search scores weighted word and phrase matches. */
export function memoryLibraries(): LibraryStore {
  const libraries = new Map<string, LibraryRecord>()
  const versions = new Map<string, Map<string, LibraryVersionRecord>>()
  const chunks = new Map<string, StoredChunk>()
  const issues = new Map<string, LibraryIssue>()

  const toChunk = (stored: StoredChunk): LibraryChunk => ({
    ...clone(stored.chunk),
    versions: newestVersionsFirst(stored.versions),
  })

  const dropOrphans = () => {
    for (const [id, stored] of chunks) if (!stored.versions.size) chunks.delete(id)
  }

  const matches = (stored: StoredChunk, filter: LibraryChunkFilter = {}) =>
    (filter.ecosystem === undefined || stored.chunk.ecosystem === filter.ecosystem) &&
    (filter.name === undefined || stored.chunk.name === filter.name) &&
    (filter.version === undefined || stored.versions.has(filter.version)) &&
    (filter.source === undefined || stored.chunk.source === filter.source) &&
    (filter.path === undefined || stored.chunk.path === filter.path)

  const inOrder = () =>
    [...chunks.values()].toSorted(
      (a, b) =>
        compareText(a.chunk.path, b.chunk.path) ||
        a.position - b.position ||
        compareText(a.chunk.ecosystem, b.chunk.ecosystem) ||
        compareText(a.chunk.name, b.chunk.name) ||
        compareText(a.chunk.id, b.chunk.id),
    )

  return {
    putLibrary: async (record) => void libraries.set(libraryKey(record), clone(record)),
    getLibrary: async (ref) => clone(libraries.get(libraryKey(ref))),
    async listLibraries({ ecosystem, query } = {}) {
      const needle = query?.toLowerCase()
      return [...libraries.values()]
        .filter(
          (record) =>
            (ecosystem === undefined || record.ecosystem === ecosystem) &&
            (needle === undefined || record.name.toLowerCase().includes(needle)),
        )
        .toSorted((a, b) => compareText(a.ecosystem, b.ecosystem) || compareText(a.name, b.name))
        .map(clone)
    },
    async removeLibrary(ref) {
      const key = libraryKey(ref)
      libraries.delete(key)
      versions.delete(key)
      for (const [id, stored] of chunks) if (sameLibrary(stored.chunk, ref)) chunks.delete(id)
      for (const [id, issue] of issues) if (sameLibrary(issue, ref)) issues.delete(id)
    },

    async putVersion(record) {
      const key = libraryKey(record)
      const list = versions.get(key) ?? new Map<string, LibraryVersionRecord>()
      list.set(record.version, clone(record))
      versions.set(key, list)
    },
    getVersion: async (ref, version) => clone(versions.get(libraryKey(ref))?.get(version)),
    async listVersions(ref) {
      return [...(versions.get(libraryKey(ref))?.values() ?? [])]
        .toSorted((a, b) => compareLibraryVersions(b.version, a.version))
        .map(clone)
    },
    async removeVersion(ref, version) {
      versions.get(libraryKey(ref))?.delete(version)
      for (const stored of chunks.values())
        if (sameLibrary(stored.chunk, ref)) stored.versions.delete(version)
      dropOrphans()
    },

    async replaceChunks(ref, version, source, input) {
      const ids = new Set<string>()
      input.forEach((chunk, position) => {
        if (ids.has(chunk.id)) return
        ids.add(chunk.id)
        const previous = chunks.get(chunk.id)
        chunks.set(chunk.id, {
          chunk: { ...plainChunk(chunk), ecosystem: ref.ecosystem, name: ref.name, source },
          versions: new Set([...(previous?.versions ?? []), version]),
          position,
        })
      })
      for (const [id, stored] of chunks)
        if (sameLibrary(stored.chunk, ref) && stored.chunk.source === source && !ids.has(id))
          stored.versions.delete(version)
      dropOrphans()
    },
    async listChunks(filter, limit = 200) {
      return inOrder()
        .filter((stored) => matches(stored, filter))
        .slice(0, limit)
        .map(toChunk)
    },
    async searchChunks(text, filter, limit = 20) {
      const terms = libraryQueryTerms(text)
      if (!terms.length) return []
      return inOrder()
        .filter((stored) => matches(stored, filter))
        .map((stored) => ({
          stored,
          score: termScore(terms, [
            [3, stored.chunk.headings.join('\n')],
            [1, stored.chunk.text],
          ]),
        }))
        .filter((hit) => hit.score > 0)
        .toSorted((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((hit) => ({ chunk: toChunk(hit.stored), score: hit.score }))
    },

    async putIssues(list) {
      for (const issue of list) issues.set(issue.id, clone(issue))
    },
    getIssue: async (id) => clone(issues.get(id)),
    async searchIssues(text, filter = {}, limit = 20) {
      const terms = libraryQueryTerms(text)
      if (!terms.length) return []
      return [...issues.values()]
        .filter(
          (issue) =>
            (filter.ecosystem === undefined || issue.ecosystem === filter.ecosystem) &&
            (filter.name === undefined || issue.name === filter.name) &&
            (filter.state === undefined || issue.state === filter.state),
        )
        .map((issue) => ({
          issue,
          score: termScore(terms, [
            [5, issue.title],
            [3, libraryIssueDigestText(issue)],
            [1, libraryIssueBodyText(issue)],
          ]),
        }))
        .filter((hit) => hit.score > 0)
        .toSorted(
          (a, b) =>
            b.score - a.score ||
            compareText(b.issue.updatedAt, a.issue.updatedAt) ||
            compareText(a.issue.id, b.issue.id),
        )
        .slice(0, limit)
        .map((hit) => ({ issue: clone(hit.issue), score: hit.score }))
    },
    async libraryStats({ ecosystem } = {}) {
      const stats = new Map<string, LibraryStats>()
      for (const record of libraries.values())
        if (ecosystem === undefined || record.ecosystem === ecosystem)
          stats.set(`${record.ecosystem}:${record.name}`, {
            versions: versions.get(libraryKey(record))?.size ?? 0,
            chunks: 0,
            issues: 0,
          })
      const bump = (ref: LibraryRef, field: 'chunks' | 'issues') => {
        const entry = stats.get(`${ref.ecosystem}:${ref.name}`)
        if (entry) entry[field] += 1
      }
      for (const stored of chunks.values()) bump(stored.chunk, 'chunks')
      for (const issue of issues.values()) bump(issue, 'issues')
      return stats
    },
  }
}
