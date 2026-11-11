import type {
  CreateKnowledgeInput,
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgePackage,
  KnowledgeStatus,
  KnowledgeVisibility,
  Scope,
} from '@holtkeeper/api'

import type { Space } from './guide.ts'
import { repoKey } from './repo.ts'
import { isEmptyScope, normalizeScope } from './scope.ts'

/** Settings edited in the Knowledge page's settings sheet instead of a Settings tab. */
export const knowledgeSettingKeys: readonly string[] = ['knowledge.autoAccept', 'analyzers.review']

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

/** Entries whose scope names the group, alone or in a `frontend + storefront` entry. */
export const entriesOfGroup = (entries: readonly KnowledgeEntry[], group: string) =>
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
export function notesOfSpace(
  entries: readonly KnowledgeEntry[],
  space: Space,
  members: readonly string[] = [],
): KnowledgeEntry[] {
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

/** How Notes cards are grouped. */
export type NoteGrouping = 'topic' | 'kind'

/** A heading of the Notes tab with its cards. */
export interface NoteGroup {
  id: string
  label: string
  entries: KnowledgeEntry[]
}

const NO_TOPIC = 'No topic'

const byReview = (a: KnowledgeEntry, b: KnowledgeEntry) =>
  Number(b.status === 'proposed') - Number(a.status === 'proposed') ||
  b.updatedAt.localeCompare(a.updatedAt)

/**
 * Entries under headings: by their first topic (alphabetically, entries without one last) or by
 * kind (in `knowledgeKinds` order). Proposals come first in each group, then the newest.
 */
export function groupNotes(entries: readonly KnowledgeEntry[], by: NoteGrouping): NoteGroup[] {
  const groups = new Map<string, KnowledgeEntry[]>()
  for (const entry of entries) {
    const id = by === 'kind' ? entry.kind : (entry.topics[0] ?? '')
    groups.set(id, [...(groups.get(id) ?? []), entry])
  }
  const order = (id: string) =>
    by === 'kind' ? knowledgeKinds.findIndex((k) => k.id === id) : id === '' ? 1 : 0
  return [...groups]
    .toSorted(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([id, list]) => ({
      id,
      label: by === 'kind' && isKnowledgeKind(id) ? kindLabel(id) : id || NO_TOPIC,
      entries: list.toSorted(byReview),
    }))
}

/** Count of entries per status. */
export function countByStatus(entries: readonly KnowledgeEntry[]): Record<KnowledgeStatus, number> {
  const counts: Record<KnowledgeStatus, number> = {
    proposed: 0,
    accepted: 0,
    rejected: 0,
    archived: 0,
  }
  for (const entry of entries) counts[entry.status] += 1
  return counts
}
