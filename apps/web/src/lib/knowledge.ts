import type {
  CreateKnowledgeInput,
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgePackage,
  KnowledgeStatus,
  Scope,
} from '@holtkeeper/api'

import { isEmptyScope, normalizeScope } from './scope.ts'

export const knowledgeKinds: readonly { id: KnowledgeKind; label: string; hint: string }[] = [
  { id: 'convention', label: 'Convention', hint: 'How code is written here' },
  { id: 'decision', label: 'Decision', hint: 'A choice the team made and why' },
  { id: 'migration', label: 'Migration', hint: 'Steps for a package upgrade' },
  { id: 'quirk', label: 'Quirk', hint: 'Something surprising about the code or tooling' },
  { id: 'howto', label: 'How-to', hint: 'How to get a task done' },
]

export const knowledgeStatuses: readonly { id: KnowledgeStatus; label: string }[] = [
  { id: 'proposed', label: 'Proposed' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'archived', label: 'Archived' },
]

/** Task kinds an entry may apply to; `*` is every task. */
export const taskKinds: readonly { id: string; label: string }[] = [
  { id: '*', label: 'Every task' },
  { id: 'review', label: 'Review' },
  { id: 'port', label: 'Port' },
  { id: 'propagate', label: 'Propagate' },
  { id: 'tests', label: 'Tests' },
  { id: 'quality', label: 'Quality' },
  { id: 'release-risk', label: 'Release risk' },
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
  evidence: KnowledgeLink[]
  version?: number
}

export const emptyDraft = (scope: Scope = { all: true }): KnowledgeDraft => ({
  title: '',
  body: '',
  kind: 'convention',
  scope,
  topics: [],
  appliesTo: ['*'],
  packages: [],
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
    evidence,
    ...(draft.version !== undefined ? { version: draft.version } : {}),
  }
}

/** Entries whose scope names the group. */
export const entriesOfGroup = (entries: readonly KnowledgeEntry[], group: string) =>
  entries.filter((entry) => entry.scope.groups?.includes(group))

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
