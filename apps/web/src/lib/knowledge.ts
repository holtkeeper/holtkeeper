import type {
  CreateKnowledgeInput,
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgePackage,
  KnowledgeRevision,
  KnowledgeStatus,
  KnowledgeVisibility,
  Scope,
  UpdateKnowledgeInput,
} from '@holtkeeper/api'

import type { Space } from './guide.ts'
import { repoKey } from './repo.ts'
import { isEmptyScope, normalizeScope } from './scope.ts'

export const knowledgeKinds: readonly { id: KnowledgeKind; label: string; hint: string }[] = [
  { id: 'convention', label: 'Convention', hint: 'How code is written here' },
  { id: 'decision', label: 'Decision', hint: 'A choice the team made and why' },
  { id: 'migration', label: 'Migration', hint: 'Steps for a package upgrade' },
  { id: 'quirk', label: 'Quirk', hint: 'Something surprising about the code or tooling' },
  { id: 'howto', label: 'How-to', hint: 'How to get a task done' },
]

/** Task kinds an entry may apply to; `*` is every task. */
export const taskKinds: readonly { id: string; label: string }[] = [
  { id: '*', label: 'Every task' },
  { id: 'review', label: 'Review' },
  { id: 'port', label: 'Port' },
  { id: 'propagate', label: 'Propagate' },
]

export const isKnowledgeKind = (value: string): value is KnowledgeKind =>
  knowledgeKinds.some((kind) => kind.id === value)

export const kindLabel = (kind: KnowledgeKind): string =>
  knowledgeKinds.find((k) => k.id === kind)?.label ?? kind

export const statusTone = (status: KnowledgeStatus) =>
  status === 'accepted'
    ? ('success' as const)
    : status === 'proposed'
      ? ('warning' as const)
      : status === 'rejected'
        ? ('danger' as const)
        : ('default' as const)

/** What the entry editor holds; `version` guards against overwriting someone else's edit. */
export interface KnowledgeDraft {
  title: string
  body: string
  kind: KnowledgeKind
  scope: Scope
  topics: string[]
  appliesTo: string[]
  packages: KnowledgePackage[]
  /** `auto` lets the server decide: shared for a decision or convention about one package. */
  visibility: KnowledgeVisibility | 'auto'
  /** `npm:react`, `tool:node`; blank for none (an entry about one package gets it from there). */
  subject: string
  evidence: KnowledgeLink[]
  version?: number
}

/** Who reads a note, as the editor offers it. */
export const visibilityOptions = [
  { id: 'auto', label: 'Default', hint: 'Shared when it decides about one package' },
  { id: 'team', label: 'My team', hint: 'Only people its scope covers' },
  { id: 'shared', label: 'Shared', hint: 'Other teams read it through the cross-team catalog' },
] as const

export const isVisibility = (value: string): value is KnowledgeDraft['visibility'] =>
  visibilityOptions.some((option) => option.id === value)

export const emptyDraft = (scope: Scope = { all: true }): KnowledgeDraft => ({
  title: '',
  body: '',
  kind: 'convention',
  scope,
  topics: [],
  appliesTo: ['*'],
  packages: [],
  visibility: 'auto',
  subject: '',
  evidence: [],
})

export const draftOf = (entry: KnowledgeEntry): KnowledgeDraft => ({
  title: entry.title,
  body: entry.body,
  kind: entry.kind,
  scope: entry.scope,
  topics: entry.topics,
  appliesTo: entry.appliesTo,
  packages: entry.packages ?? [],
  visibility: entry.visibility ?? 'team',
  subject: entry.subject ?? '',
  evidence: entry.evidence,
  version: entry.version,
})

/** Problems that keep the draft from saving, in the order the form shows its fields. */
export function draftProblems(draft: KnowledgeDraft): string[] {
  const problems: string[] = []
  if (!draft.title.trim()) problems.push('Add a title')
  if (!draft.body.trim()) problems.push('Add an explanation')
  if (isEmptyScope(draft.scope)) problems.push('Choose where it applies')
  if (!draft.appliesTo.length) problems.push('Choose at least one task kind')
  const packages = cleanPackages(draft.packages)
  if (draft.kind === 'migration' && !packages.length)
    problems.push('A migration names the package it is about')
  return problems
}

const cleanPackages = (packages: readonly KnowledgePackage[]): KnowledgePackage[] =>
  packages.flatMap((pkg) => {
    const ecosystem = pkg.ecosystem.trim()
    const name = pkg.name.trim()
    if (!ecosystem || !name) return []
    const from = pkg.from?.trim()
    const to = pkg.to?.trim()
    return [{ ecosystem, name, ...(from ? { from } : {}), ...(to ? { to } : {}) }]
  })

/** The request body for a draft: trimmed text, normalized scope, no blank rows. */
export function inputOf(draft: KnowledgeDraft): CreateKnowledgeInput & { version?: number } {
  const packages = cleanPackages(draft.packages)
  const evidence = draft.evidence
    .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
    .filter((link) => link.url)
    .map((link) => ({ label: link.label || link.url, url: link.url }))
  return {
    title: draft.title.trim(),
    body: draft.body.trim(),
    kind: draft.kind,
    scope: normalizeScope(draft.scope),
    topics: [...new Set(draft.topics.map((t) => t.trim().toLowerCase()).filter(Boolean))],
    appliesTo: draft.appliesTo.includes('*') ? ['*'] : draft.appliesTo,
    ...(packages.length ? { packages } : {}),
    ...(draft.visibility === 'auto' ? {} : { visibility: draft.visibility }),
    ...(draft.subject.trim() ? { subject: draft.subject.trim() } : {}),
    evidence,
    ...(draft.version !== undefined ? { version: draft.version } : {}),
  }
}

const entriesOfGroup = <T extends KnowledgeEntry>(entries: readonly T[], group: string) =>
  entries.filter((entry) =>
    entry.scope.groups?.some((match) =>
      typeof match === 'string' ? match === group : match.includes(group),
    ),
  )

const namesRepo = (scope: Scope, key: string) => {
  const path = key.slice(key.indexOf(':') + 1)
  return scope.repos?.some((pattern) => pattern === key || pattern === path) ?? false
}

/**
 * Notes a space lists: every entry for *All*, entries naming the group or a family member, and
 * for a repository the entries the server found covering it (`entries` is then already filtered).
 */
export function notesOfSpace<T extends KnowledgeEntry>(
  entries: readonly T[],
  space: Space,
  members: readonly string[] = [],
): T[] {
  if (space.kind === 'group') return entriesOfGroup(entries, space.group)
  if (space.kind === 'family')
    return entries.filter((entry) => members.some((member) => namesRepo(entry.scope, member)))
  return [...entries]
}

/** Whether a repository space shows the entry only because a broader scope covers it. */
export const isInherited = (entry: KnowledgeEntry, space: Space): boolean =>
  space.kind === 'repo' && !namesRepo(entry.scope, repoKey(space.repo))

/** What the Notes tab shows: live entries (proposals and accepted), rejected or archived ones. */
export type NoteFilter = 'live' | 'rejected' | 'archived'

export const noteFilters: readonly { id: NoteFilter; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'archived', label: 'Archived' },
]

export const matchesFilter = (entry: KnowledgeEntry, filter: NoteFilter): boolean =>
  filter === 'live'
    ? entry.status === 'proposed' || entry.status === 'accepted'
    : entry.status === filter

/** How Notes rows are grouped. */
export type NoteGrouping = 'status' | 'topic' | 'kind'

const statusOrder = ['proposed', 'accepted', 'rejected', 'archived'] as const

const statusLabels: Record<string, string> = {
  proposed: 'Waiting for review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  archived: 'Archived',
}

/** A heading row of the Notes table with the rows under it. */
export interface NoteGroup<T extends KnowledgeEntry = KnowledgeEntry> {
  id: string
  label: string
  entries: T[]
}

const NO_TOPIC = 'No topic'

const byReview = (a: KnowledgeEntry, b: KnowledgeEntry) =>
  Number(b.status === 'proposed') - Number(a.status === 'proposed') ||
  b.updatedAt.localeCompare(a.updatedAt)

/**
 * Entries under headings: by status (waiting, accepted, rejected, archived), by their first topic
 * (alphabetically, entries without one last) or by kind (in `knowledgeKinds` order). Proposals
 * come first in each group, then the newest.
 */
export function groupNotes<T extends KnowledgeEntry>(
  entries: readonly T[],
  by: NoteGrouping,
): NoteGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const entry of entries) {
    const id = by === 'kind' ? entry.kind : by === 'status' ? entry.status : (entry.topics[0] ?? '')
    groups.set(id, [...(groups.get(id) ?? []), entry])
  }
  const order = (id: string) =>
    by === 'kind'
      ? knowledgeKinds.findIndex((k) => k.id === id)
      : by === 'status'
        ? statusOrder.findIndex((status) => status === id)
        : id === ''
          ? 1
          : 0
  return [...groups]
    .toSorted(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([id, list]) => ({
      id,
      label:
        by === 'kind' && isKnowledgeKind(id)
          ? kindLabel(id)
          : by === 'status'
            ? (statusLabels[id] ?? id)
            : id || NO_TOPIC,
      entries: list.toSorted(byReview),
    }))
}

/**
 * The Notes table's sections: proposals first under "Waiting for review" (newest first), then the
 * rest grouped by topic or kind.
 */
export function noteSections<T extends KnowledgeEntry>(
  entries: readonly T[],
  by: NoteGrouping,
): NoteGroup<T>[] {
  const proposals = entries
    .filter((entry) => entry.status === 'proposed')
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const rest = groupNotes(
    entries.filter((entry) => entry.status !== 'proposed'),
    by,
  )
  return proposals.length
    ? [{ id: 'proposed', label: 'Waiting for review', entries: proposals }, ...rest]
    : rest
}

/** What narrows the Notes table besides the space. */
export interface NoteQuery {
  filter: NoteFilter
  /** Lowercased text matched against title, body, topics and the id. */
  text: string
  /** Kinds to keep; empty keeps every kind. */
  kinds: readonly string[]
  /** Topics to keep (any of them); empty keeps every entry. */
  topics: readonly string[]
  /** Task kinds to keep: entries whose `appliesTo` names one of them or every task (`*`). */
  tasks?: readonly string[]
}

/** Entries matching the status filter, the text and the kind, topic and task choices. */
export function filterNotes<T extends KnowledgeEntry>(
  entries: readonly T[],
  query: NoteQuery,
): T[] {
  const needle = query.text.trim().toLowerCase().replace(/^kb:/, '')
  return entries.filter(
    (entry) =>
      matchesFilter(entry, query.filter) &&
      (!query.kinds.length || query.kinds.includes(entry.kind)) &&
      (!query.topics.length || entry.topics.some((topic) => query.topics.includes(topic))) &&
      (!query.tasks?.length ||
        entry.appliesTo.some((task) => task === '*' || query.tasks?.includes(task))) &&
      (!needle ||
        entry.id.toLowerCase().startsWith(needle) ||
        entry.title.toLowerCase().includes(needle) ||
        entry.body.toLowerCase().includes(needle) ||
        entry.topics.some((topic) => topic.includes(needle))),
  )
}

/** Every topic of the entries, sorted, for the topic filter. */
export const noteTopics = (entries: readonly KnowledgeEntry[]): string[] =>
  [...new Set(entries.flatMap((entry) => entry.topics))].toSorted()

/** Figures of the Notes summary strip. */
export interface NoteTotals {
  accepted: number
  proposed: number
  /** Live entries a repository space shows only because a broader scope covers it. */
  inherited: number
  /** Accepted entries other teams read through the cross-team catalog. */
  shared: number
}

/** The strip's figures over the entries of a space. */
export function noteTotals(entries: readonly KnowledgeEntry[], space: Space): NoteTotals {
  const live = entries.filter((entry) => matchesFilter(entry, 'live'))
  return {
    accepted: live.filter((entry) => entry.status === 'accepted').length,
    proposed: live.filter((entry) => entry.status === 'proposed').length,
    inherited: live.filter((entry) => isInherited(entry, space)).length,
    shared: live.filter((entry) => entry.status === 'accepted' && entry.visibility === 'shared')
      .length,
  }
}

export const noteStatusLabel: Record<KnowledgeStatus, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  rejected: 'Rejected',
  archived: 'Archived',
}

/** The id agents cite a note by: `kb:<id>`; `short` keeps the first 8 characters. */
export const kbId = (id: string, short = false): string => `kb:${short ? id.slice(0, 8) : id}`

/** Link to a note opened in the Notes sheet. */
export const noteLink = (origin: string, id: string): string =>
  `${origin}/knowledge/notes?note=${encodeURIComponent(id)}`

/** One version of a note in its History tab, the current one first. */
export interface NoteVersion {
  version: number
  by: string
  at: string
  /** What differs from the version before it; empty for the first one. */
  changed: string[]
  current: boolean
  revision?: KnowledgeRevision
}

type NoteContent = Omit<KnowledgeRevision, 'version' | 'editedBy' | 'editedAt'>

const fieldLabels: [keyof NoteContent, string][] = [
  ['title', 'title'],
  ['body', 'text'],
  ['kind', 'kind'],
  ['scope', 'scope'],
  ['topics', 'topics'],
  ['appliesTo', 'tasks'],
  ['packages', 'packages'],
  ['visibility', 'visibility'],
  ['subject', 'subject'],
  ['status', 'status'],
  ['evidence', 'evidence'],
]

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Fields that differ between two versions of a note, in form order. */
export const changedFields = (before: NoteContent, after: NoteContent): string[] =>
  fieldLabels.filter(([key]) => !same(before[key], after[key])).map(([, label]) => label)

/** The entry and its previous versions (newest first) as History rows, current first. */
export function noteVersions(
  entry: KnowledgeEntry,
  history: readonly KnowledgeRevision[],
): NoteVersion[] {
  const older = history.toSorted((a, b) => b.version - a.version)
  const rows: NoteVersion[] = [
    {
      version: entry.version,
      by: entry.updatedBy ?? entry.author,
      at: entry.updatedAt,
      changed: older[0] ? changedFields(older[0], entry) : [],
      current: true,
    },
  ]
  older.forEach((revision, index) => {
    const before = older[index + 1]
    rows.push({
      version: revision.version,
      by: revision.editedBy,
      at: revision.editedAt,
      changed: before ? changedFields(before, revision) : [],
      current: false,
      revision,
    })
  })
  return rows
}

/** The update that brings back an older version's content, guarded by the current version. */
export const restoreInput = (
  entry: KnowledgeEntry,
  revision: KnowledgeRevision,
): UpdateKnowledgeInput => ({
  title: revision.title,
  body: revision.body,
  kind: revision.kind,
  scope: revision.scope,
  topics: revision.topics,
  appliesTo: revision.appliesTo,
  ...(revision.packages?.length ? { packages: revision.packages } : {}),
  ...(revision.visibility ? { visibility: revision.visibility } : {}),
  ...(revision.subject ? { subject: revision.subject } : {}),
  evidence: revision.evidence,
  version: entry.version,
})
