import type { ChangelogCommit, Person } from './types.ts'

/** Changelog section ids, in display order. */
export const sectionOrder = [
  'breaking',
  'features',
  'fixes',
  'performance',
  'refactoring',
  'reverts',
  'docs',
  'tests',
  'build',
  'chores',
  'other',
] as const

export type SectionId = (typeof sectionOrder)[number]

/** Display titles of sections. */
export const sectionTitles: Record<SectionId, string> = {
  breaking: 'Breaking changes',
  features: 'Features',
  fixes: 'Fixes',
  performance: 'Performance',
  refactoring: 'Refactoring',
  reverts: 'Reverts',
  docs: 'Docs',
  tests: 'Tests',
  build: 'Build & CI',
  chores: 'Chores',
  other: 'Other',
}

const typeSections: Record<string, SectionId> = {
  feat: 'features',
  fix: 'fixes',
  perf: 'performance',
  refactor: 'refactoring',
  revert: 'reverts',
  docs: 'docs',
  test: 'tests',
  build: 'build',
  ci: 'build',
  chore: 'chores',
  style: 'chores',
  deps: 'chores',
  release: 'chores',
}

/** Section a commit belongs to; breaking changes always go to `breaking`. */
export function sectionOf(commit: Pick<ChangelogCommit, 'parsed'>): SectionId {
  if (commit.parsed.breaking) return 'breaking'
  return typeSections[commit.parsed.type ?? ''] ?? 'other'
}

/**
 * Message reduced to what makes two commits "the same change": lowercased, without ticket and
 * merge request references, `WIP`/`fixup!`/`squash!` markers, extra whitespace and trailing
 * punctuation. Works for any script, not only Latin.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/^(?:(?:fixup|squash|amend)!\s*)+/iu, '')
    .replace(/\[?\bwip\b\]?:?/giu, ' ')
    .replace(/\[?\b[A-Z][A-Z0-9]+-\d+\b\]?:?/gu, ' ')
    .replace(/\(?[#!]\d+\b\)?/gu, ' ')
    .replace(/\[\s*\]|\(\s*\)/gu, ' ')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\s.,;:!?…]+$/u, '')
    .replace(/^[\s:,;-]+/u, '')
}

/** Commits with the same type, scope and normalized description, collapsed into one entry. */
export interface CommitCluster {
  /** Stable within one changelog: section, scope and normalized message. */
  key: string
  section: SectionId
  type?: string
  scope?: string
  breaking: boolean
  /** Description of the newest commit in the cluster. */
  title: string
  /** Newest first. */
  commits: ChangelogCommit[]
  tickets: string[]
  mergeRequests: number[]
  /** Distinct author names. */
  authors: string[]
  firstAt: string
  lastAt: string
}

export interface ChangelogSection {
  id: SectionId
  title: string
  /** Scoped clusters first (alphabetically), unscoped last; each newest first. */
  scopes: { scope?: string; clusters: CommitCluster[] }[]
}

export interface Contributor extends Person {
  commits: number
  /** Commits where the person is only listed as `Co-authored-by`. */
  coAuthored: number
  insertions: number
  deletions: number
}

export interface TicketSummary {
  id: string
  /** Newest first. */
  shas: string[]
  /** Descriptions of the clusters that mention the ticket. */
  titles: string[]
}

export interface MergeRequestSummary {
  number: number
  title: string
  shas: string[]
}

/** Everything a changelog shows, derived from commits alone. */
export interface ChangelogGroups {
  sections: ChangelogSection[]
  /** Merge commits, collapsed like other commits but kept out of sections. */
  merges: CommitCluster[]
  /** By commit count, most active first. */
  contributors: Contributor[]
  tickets: TicketSummary[]
  mergeRequests: MergeRequestSummary[]
}

function clusterOf(commits: ChangelogCommit[], section: SectionId, key: string): CommitCluster {
  const newest = commits[0]
  if (!newest) throw new Error('empty cluster')
  const dates = commits.map((commit) => commit.date).toSorted()
  return {
    key,
    section,
    ...(newest.parsed.type ? { type: newest.parsed.type } : {}),
    ...(newest.parsed.scope ? { scope: newest.parsed.scope } : {}),
    breaking: commits.some((commit) => commit.parsed.breaking),
    title: newest.parsed.description || newest.subject,
    commits,
    tickets: [...new Set(commits.flatMap((commit) => commit.parsed.tickets))],
    mergeRequests: [...new Set(commits.flatMap((commit) => commit.parsed.mergeRequests))],
    authors: [...new Set(commits.map((commit) => commit.author.name))],
    firstAt: dates[0] ?? newest.date,
    lastAt: dates.at(-1) ?? newest.date,
  }
}

/** Collapses commits by key, preserving the order in which keys first appear. */
function collapse(
  commits: ChangelogCommit[],
  keyOf: (commit: ChangelogCommit) => string,
  sectionFor: (commit: ChangelogCommit) => SectionId,
): CommitCluster[] {
  const buckets = new Map<string, ChangelogCommit[]>()
  for (const commit of commits) {
    const key = keyOf(commit)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(commit)
    else buckets.set(key, [commit])
  }
  return [...buckets].map(([key, bucket]) => clusterOf(bucket, sectionFor(bucket[0]!), key))
}

const isMerge = (commit: ChangelogCommit) => commit.parsed.merge || commit.parents.length > 1

const byDateDesc = (a: ChangelogCommit, b: ChangelogCommit) => b.date.localeCompare(a.date)

/** Groups commits (any order) into sections, clusters, contributors, tickets and merge requests. */
export function groupCommits(commits: readonly ChangelogCommit[]): ChangelogGroups {
  const sorted = commits.toSorted(byDateDesc)
  const regular = sorted.filter((commit) => !isMerge(commit))
  const merges = sorted.filter(isMerge)

  const clusters = collapse(
    regular,
    (commit) =>
      [
        sectionOf(commit),
        commit.parsed.type ?? '',
        commit.parsed.scope?.toLowerCase() ?? '',
        normalizeMessage(commit.parsed.description || commit.subject),
      ].join('\u0000'),
    sectionOf,
  )

  const sections: ChangelogSection[] = []
  for (const id of sectionOrder) {
    const inSection = clusters.filter((cluster) => cluster.section === id)
    if (inSection.length === 0) continue
    const scopes = new Map<string, CommitCluster[]>()
    for (const cluster of inSection) {
      const scope = cluster.scope ?? ''
      scopes.set(scope, [...(scopes.get(scope) ?? []), cluster])
    }
    sections.push({
      id,
      title: sectionTitles[id],
      scopes: [...scopes]
        .toSorted(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
        .map(([scope, list]) => (scope ? { scope, clusters: list } : { clusters: list })),
    })
  }

  const mergeClusters = collapse(
    merges,
    (commit) => normalizeMessage(commit.parsed.description || commit.subject),
    () => 'other',
  )

  return {
    sections,
    merges: mergeClusters,
    contributors: contributorsOf(sorted),
    tickets: ticketsOf(clusters),
    mergeRequests: mergeRequestsOf([...clusters, ...mergeClusters]),
  }
}

function contributorsOf(commits: ChangelogCommit[]): Contributor[] {
  const people = new Map<string, Contributor>()
  const get = (person: Person) => {
    const key = (person.email || person.name).toLowerCase()
    let entry = people.get(key)
    if (!entry) {
      entry = { ...person, commits: 0, coAuthored: 0, insertions: 0, deletions: 0 }
      people.set(key, entry)
    }
    return entry
  }
  for (const commit of commits) {
    const author = get(commit.author)
    author.commits++
    author.insertions += commit.stats.insertions
    author.deletions += commit.stats.deletions
    for (const co of commit.parsed.coAuthors) get(co).coAuthored++
  }
  return [...people.values()].toSorted(
    (a, b) => b.commits - a.commits || b.coAuthored - a.coAuthored || a.name.localeCompare(b.name),
  )
}

function ticketsOf(clusters: CommitCluster[]): TicketSummary[] {
  const tickets = new Map<string, TicketSummary>()
  for (const cluster of clusters) {
    for (const id of cluster.tickets) {
      const entry = tickets.get(id) ?? { id, shas: [], titles: [] }
      entry.shas.push(...cluster.commits.map((commit) => commit.sha))
      if (!entry.titles.includes(cluster.title)) entry.titles.push(cluster.title)
      tickets.set(id, entry)
    }
  }
  return [...tickets.values()]
}

function mergeRequestsOf(clusters: CommitCluster[]): MergeRequestSummary[] {
  const requests = new Map<number, MergeRequestSummary>()
  for (const cluster of clusters) {
    for (const commit of cluster.commits) {
      for (const number of commit.parsed.mergeRequests) {
        const entry = requests.get(number) ?? { number, title: commit.parsed.description, shas: [] }
        entry.shas.push(commit.sha)
        requests.set(number, entry)
      }
    }
  }
  return [...requests.values()].toSorted((a, b) => b.number - a.number)
}
