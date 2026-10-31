import type {
  LibraryDetail,
  LibraryIndexProgressView,
  LibraryIndexRun,
  LibrarySearchResult,
  LibrarySourceCoverage,
  LibrarySummary,
} from '@holtkeeper/api'

import { durationBetween, plural } from './format.ts'

export type LibraryEcosystem = LibrarySummary['ecosystem']
export type LibraryVersion = LibraryDetail['versions'][number]
export type LibraryRole = LibraryVersion['roles'][number]
export type LibrarySourceKind = keyof LibraryVersion['sources']
export type LibrarySourceState = NonNullable<LibraryVersion['sources'][LibrarySourceKind]>
export type LibraryDocSource = LibraryDetail['documents'][number]['source']
export type LibraryHit = LibrarySearchResult['hits'][number]

type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger'

/** Ecosystems in display order. */
export const libraryEcosystems: readonly { id: LibraryEcosystem; label: string }[] = [
  { id: 'npm', label: 'npm' },
  { id: 'Go', label: 'Go' },
]

/** `npm` or `Go` from a URL value; anything else is `undefined`. */
export const parseEcosystem = (value: unknown): LibraryEcosystem | undefined =>
  libraryEcosystems.find((e) => e.id === value)?.id

const roles: readonly { id: LibraryRole; label: string; description: string }[] = [
  { id: 'used', label: 'used', description: 'Some repository resolves to it' },
  { id: 'latest', label: 'latest', description: 'Newest stable release' },
  { id: 'minor', label: 'newest minor', description: 'Newest release of a used major' },
  { id: 'patch', label: 'newest patch', description: 'Newest release of a used minor' },
  {
    id: 'major',
    label: 'next major',
    description: 'Newest release of a major above the used ones',
  },
  { id: 'first', label: 'first of major', description: 'First release of such a major' },
]

/** Roles of a version in display order with labels and what each means. */
export const formatRoles = (
  list: readonly LibraryRole[],
): { id: LibraryRole; label: string; description: string }[] =>
  roles.filter((role) => list.includes(role.id))

const roleTone: Record<LibraryRole, Tone> = {
  used: 'accent',
  latest: 'success',
  minor: 'default',
  patch: 'default',
  major: 'warning',
  first: 'default',
}

/** Chip tone of a role. */
export const toneOfRole = (role: LibraryRole): Tone => roleTone[role]

const sourceKinds: readonly { id: LibrarySourceKind; label: string }[] = [
  { id: 'registry', label: 'Registry' },
  { id: 'archive', label: 'Package archive' },
  { id: 'api', label: 'API' },
  { id: 'repository', label: 'Repository' },
  { id: 'releases', label: 'Releases' },
  { id: 'source', label: 'Source snapshot' },
  { id: 'issues', label: 'Issues' },
  { id: 'site', label: 'Docs site' },
]

/** Human label of a source kind. */
export const sourceLabel = (kind: string): string =>
  sourceKinds.find((s) => s.id === kind)?.label ?? kind

/** The sources that have a status, in fetch order. */
export const sortedSources = (
  sources: Partial<Record<LibrarySourceKind, LibrarySourceState>>,
): { kind: LibrarySourceKind; label: string; state: LibrarySourceState }[] =>
  sourceKinds.flatMap((source) => {
    const state = sources[source.id]
    return state ? [{ kind: source.id, label: source.label, state }] : []
  })

const statusTone: Record<LibrarySourceState['status'], Tone> = {
  ok: 'success',
  missing: 'default',
  failed: 'danger',
  skipped: 'warning',
}

/** Chip tone of a source status. */
export const toneOfStatus = (status: LibrarySourceState['status']): Tone => statusTone[status]

/** Query of `GET /api/libraries`; empty values are left out. */
export const libraryListQuery = (filter: {
  q?: string
  ecosystem?: LibraryEcosystem | 'all'
}): { q?: string; ecosystem?: LibraryEcosystem } => {
  const q = filter.q?.trim()
  return {
    ...(q ? { q } : {}),
    ...(filter.ecosystem && filter.ecosystem !== 'all' ? { ecosystem: filter.ecosystem } : {}),
  }
}

/** Query of `GET /api/libraries/search`; empty values are left out. */
export const librarySearchQuery = (filter: {
  q: string
  ecosystem?: LibraryEcosystem
  name?: string
  version?: string
  limit?: number
}): { q: string; ecosystem?: string; name?: string; version?: string; limit?: number } => ({
  q: filter.q.trim(),
  ...(filter.ecosystem ? { ecosystem: filter.ecosystem } : {}),
  ...(filter.name ? { name: filter.name } : {}),
  ...(filter.version ? { version: filter.version } : {}),
  ...(filter.limit ? { limit: filter.limit } : {}),
})

const docSources: readonly LibraryDocSource[] = ['archive', 'repository', 'releases', 'site']

/** Documents grouped by source in fetch order, paths sorted within each. */
export const groupDocuments = (
  documents: LibraryDetail['documents'],
): { source: LibraryDocSource; label: string; documents: LibraryDetail['documents'] }[] =>
  docSources.flatMap((source) => {
    const list = documents
      .filter((doc) => doc.source === source)
      .toSorted((a, b) => a.path.localeCompare(b.path))
    return list.length ? [{ source, label: sourceLabel(source), documents: list }] : []
  })

/** Heading path of a chunk, `Guide › Install › npm`. */
export const headingPath = (headings: readonly string[]): string => headings.join(' › ')

/**
 * Plain text of a Markdown section, cut to about `max` characters at a word boundary: code
 * fences, link targets, images, HTML tags and emphasis marks are dropped.
 */
export function excerpt(markdown: string, max = 280): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** `url` when it is an absolute http(s) URL, else `undefined`; third-party links go through it. */
export const httpUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

/** One line about an indexing run: libraries, versions added and removed, failures, duration. */
export function runSummary(run: LibraryIndexRun): string {
  const parts = [
    plural(run.libraries, 'library', 'libraries'),
    `${run.versionsAdded} versions added`,
    `${run.versionsRemoved} removed`,
  ]
  if (run.librariesRemoved)
    parts.push(`${plural(run.librariesRemoved, 'library', 'libraries')} dropped`)
  if (run.failures.length) parts.push(plural(run.failures.length, 'failure'))
  if (run.finishedAt) parts.push(`took ${durationBetween(run.startedAt, run.finishedAt)}`)
  return parts.join(' · ')
}

/** Where a running index run stands: share done, time spent and a rough estimate of the rest. */
export function runProgress(
  progress: Pick<LibraryIndexProgressView, 'startedAt' | 'total' | 'done'>,
  now: Date = new Date(),
): { percent: number; elapsedMs: number; remainingMs?: number } {
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(progress.startedAt))
  const percent = progress.total ? Math.floor((progress.done / progress.total) * 100) : 0
  const left = progress.total - progress.done
  return {
    percent,
    elapsedMs,
    ...(progress.done > 0 && left > 0
      ? { remainingMs: Math.round((elapsedMs / progress.done) * left) }
      : {}),
  }
}

/** Rows of a source's coverage in display order: done, nothing there, failed, skipped, waiting. */
export const coverageParts = (row: LibrarySourceCoverage) =>
  [
    { key: 'ok', label: 'indexed', count: row.ok, tone: 'success' },
    { key: 'missing', label: 'nothing to index', count: row.missing, tone: 'default' },
    { key: 'failed', label: 'failed, retried next run', count: row.failed, tone: 'danger' },
    { key: 'skipped', label: 'skipped', count: row.skipped, tone: 'default' },
    { key: 'pending', label: 'not fetched yet', count: row.pending, tone: 'warning' },
  ] as const

/** Share of a source that is settled (indexed or found to have nothing), in whole percent. */
export const coverageDone = (row: LibrarySourceCoverage): number => {
  const total = row.ok + row.missing + row.failed + row.skipped + row.pending
  return total ? Math.floor(((row.ok + row.missing) / total) * 100) : 100
}
