import {
  type ChangelogCommit,
  type ChangelogLinks,
  type CommitCluster,
  groupCommits,
  parseCommit,
  sectionOrder,
  sectionOf,
  sectionTitles,
} from '@holtkeeper/changelog'

import type { Bump, ReleaseSettings } from './settings.ts'
import type { BumpReason, ReleaseCommit, ReleaseEdits, ReleaseEntry } from './types.ts'
import { maxBump } from './version.ts'

const toChangelogCommit = (commit: ReleaseCommit): ChangelogCommit => ({
  ...commit,
  stats: { files: 0, insertions: 0, deletions: 0 },
  parsed: parseCommit(commit.subject, commit.body),
})

const entryId = (key: string) => Bun.hash(key).toString(36)

const withoutTrailingRefs = (title: string) =>
  title.replace(/\s*\((?:[#!]\d+(?:,\s*)?)+\)\s*$/u, '').trim() || title

/** Shas of commits that are reverted by another commit of the same list, plus those reverts. */
function revertPairs(commits: readonly ChangelogCommit[]): Set<string> {
  const paired = new Set<string>()
  for (const revert of commits) {
    const target = revert.parsed.revert
    if (!target) continue
    const original = commits.find(
      (commit) =>
        commit.sha !== revert.sha &&
        !paired.has(commit.sha) &&
        (target.sha ? commit.sha.startsWith(target.sha) : commit.subject === target.subject),
    )
    if (!original) continue
    paired.add(original.sha)
    paired.add(revert.sha)
  }
  return paired
}

function ruleExcludes(settings: ReleaseSettings['changelog'], cluster: CommitCluster): boolean {
  const newest = cluster.commits[0]
  if (!newest) return true
  if (cluster.commits.every((commit) => commit.parsed.wip)) return true
  if (cluster.type && settings.excludeTypes.includes(cluster.type)) return true
  if (settings.sections?.length && !settings.sections.includes(cluster.section)) return true
  return settings.exclude.some((pattern) =>
    cluster.commits.every((commit) => new RegExp(pattern, 'iu').test(commit.subject)),
  )
}

/**
 * Changelog entries of a range: commits with the same type, scope and message are one entry, so
 * repeated messages appear once. Rules of the settings mark entries left out (`excludedBy:
 * 'rule'`), commits reverted within the range drop out with their revert, and `edits` apply last:
 * a person's choice beats the rules. Entries keep the section order of `@holtkeeper/changelog`.
 */
export function buildEntries(
  commits: readonly ReleaseCommit[],
  settings: ReleaseSettings['changelog'],
  edits: ReleaseEdits = {},
): ReleaseEntry[] {
  const parsed = commits.map(toChangelogCommit)
  const reverted = settings.revertPairs ? revertPairs(parsed) : new Set<string>()
  const groups = groupCommits(parsed)
  const regular = groups.sections.flatMap((section) =>
    section.scopes.flatMap((scope) => scope.clusters),
  )
  const merges = groups.merges.map((cluster) => {
    const newest = cluster.commits[0]
    return newest ? { ...cluster, section: sectionOf(newest) } : cluster
  })
  const clusters =
    settings.merges === 'only'
      ? merges
      : settings.merges === 'include'
        ? [...regular, ...merges]
        : regular

  return clusters
    .map((cluster): ReleaseEntry => {
      const id = entryId(cluster.key)
      const byRevert = cluster.commits.every((commit) => reverted.has(commit.sha))
      const byRule = !byRevert && ruleExcludes(settings, cluster)
      const byPerson = edits.excluded?.includes(id) ?? false
      const restored = edits.included?.includes(id) ?? false
      const excludedBy = byPerson
        ? 'person'
        : restored
          ? undefined
          : byRevert
            ? 'revert'
            : byRule
              ? 'rule'
              : undefined
      const text = edits.texts?.[id]?.trim()
      const title = withoutTrailingRefs(cluster.title)
      return {
        id,
        section: cluster.section,
        ...(cluster.type ? { type: cluster.type } : {}),
        ...(cluster.scope ? { scope: cluster.scope } : {}),
        breaking: cluster.breaking,
        title,
        text: text || title,
        tickets: cluster.tickets,
        mergeRequests: cluster.mergeRequests,
        commits: cluster.commits.map((commit) => ({
          sha: commit.sha,
          subject: commit.subject,
          author: commit.author.name,
          date: commit.date,
        })),
        authors: cluster.authors,
        included: excludedBy === undefined,
        ...(excludedBy ? { excludedBy } : {}),
      }
    })
    .toSorted((a, b) => sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section))
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : /(?:s|x|ch|sh)$/u.test(word) ? 'es' : 's'}`

/**
 * The bump the included entries call for: breaking changes, then the bump per commit type
 * (`other` for the rest), raised by merge request labels and at least `minimum` when anything is
 * included. While the major version is 0, breaking changes bump `initialDevelopment`.
 */
export function suggestBump(
  entries: readonly ReleaseEntry[],
  settings: ReleaseSettings['version']['bump'],
  options: { current?: string; labels?: readonly string[] } = {},
): { bump: Bump; reasons: BumpReason[] } {
  const included = entries.filter((entry) => entry.included)
  if (included.length === 0) return { bump: 'none', reasons: [] }
  const reasons: BumpReason[] = []
  const zeroMajor = options.current?.startsWith('0.') === true

  const breaking = included.filter((entry) => entry.breaking)
  if (breaking.length) {
    const bump = zeroMajor ? settings.initialDevelopment : settings.breaking
    reasons.push({
      bump,
      because: `${plural(breaking.length, 'breaking change')}${zeroMajor ? ' while the major version is 0' : ''}`,
      entries: breaking.map((entry) => entry.id),
    })
  }

  const byBump = new Map<Bump, Map<string, string[]>>()
  for (const entry of included) {
    if (entry.breaking) continue
    const type = entry.type ?? ''
    const bump = settings.types[type] ?? settings.other
    const types = byBump.get(bump) ?? new Map<string, string[]>()
    types.set(type, [...(types.get(type) ?? []), entry.id])
    byBump.set(bump, types)
  }
  for (const [bump, types] of byBump)
    for (const [type, ids] of types)
      reasons.push({
        bump,
        because: type ? plural(ids.length, type) : plural(ids.length, 'other change'),
        entries: ids,
      })

  for (const label of options.labels ?? []) {
    const bump = settings.labels[label]
    if (bump) reasons.push({ bump, because: `label ${label}`, entries: [] })
  }

  const bump = reasons.reduce<Bump>((max, reason) => maxBump(max, reason.bump), 'none')
  const raised = maxBump(bump, settings.minimum)
  if (raised !== bump)
    reasons.push({ bump: raised, because: `at least ${settings.minimum}`, entries: [] })
  return {
    bump: raised,
    reasons: reasons.toSorted((a, b) => rank(b.bump) - rank(a.bump)),
  }
}

const rank = (bump: Bump) => ['none', 'patch', 'minor', 'major'].indexOf(bump)

const shortSha = (sha: string) => sha.slice(0, 8)

function references(
  entry: ReleaseEntry,
  options: { links?: ChangelogLinks | undefined; withLinks: boolean },
): string {
  const { links, withLinks } = options
  const link = (label: string, url: string | undefined) =>
    withLinks && url ? `[${label}](${url})` : label
  const refs = [
    ...entry.tickets.map((ticket) => link(ticket, links?.ticket(ticket))),
    ...entry.mergeRequests.map((n) => link(`!${n}`, links?.mergeRequest(n))),
  ]
  if (refs.length === 0 && entry.commits[0])
    refs.push(link(shortSha(entry.commits[0].sha), links?.commit(entry.commits[0].sha)))
  return refs.length ? ` (${refs.join(', ')})` : ''
}

function line(
  entry: ReleaseEntry,
  options: {
    links?: ChangelogLinks | undefined
    withLinks: boolean
    authors: boolean
    scope: boolean
  },
) {
  const scope = options.scope && entry.scope ? `**${entry.scope}:** ` : ''
  const authors = options.authors && entry.authors.length ? ` — ${entry.authors.join(', ')}` : ''
  return `- ${scope}${entry.text}${references(entry, options)}${authors}`
}

/**
 * Markdown of the included entries, grouped by the settings' `groupBy`: sections as `###`
 * headings, scopes, tickets (entries without one under Other) or one flat list.
 */
export function renderChangelog(
  entries: readonly ReleaseEntry[],
  settings: ReleaseSettings['changelog'],
  links?: ChangelogLinks,
): string {
  const included = entries.filter((entry) => entry.included)
  if (included.length === 0) return ''
  const options = { links, withLinks: settings.links, authors: settings.authors }
  const block = (title: string, list: ReleaseEntry[], scope: boolean) =>
    `### ${title}\n\n${list.map((entry) => line(entry, { ...options, scope })).join('\n')}`

  if (settings.groupBy === 'none')
    return included.map((entry) => line(entry, { ...options, scope: true })).join('\n')

  const groups = new Map<string, ReleaseEntry[]>()
  const add = (key: string, entry: ReleaseEntry) => {
    const list = groups.get(key) ?? []
    if (!list.includes(entry)) list.push(entry)
    groups.set(key, list)
  }
  for (const entry of included) {
    if (settings.groupBy === 'section') add(sectionTitles[entry.section], entry)
    else if (settings.groupBy === 'scope') add(entry.scope ?? '', entry)
    else if (entry.tickets.length) for (const ticket of entry.tickets) add(ticket, entry)
    else add('', entry)
  }
  const keys = [...groups.keys()]
  const ordered =
    settings.groupBy === 'section'
      ? keys
      : [
          ...keys.filter(Boolean).toSorted((a, b) => a.localeCompare(b)),
          ...keys.filter((key) => !key),
        ]
  return ordered
    .map((key) => block(key || 'Other', groups.get(key) ?? [], settings.groupBy !== 'scope'))
    .join('\n\n')
}

/** A short digest of the entries for people who skip the changelog. */
export function digestSummary(entries: readonly ReleaseEntry[]): string {
  const included = entries.filter((entry) => entry.included)
  if (included.length === 0) return ''
  const count = (test: (entry: ReleaseEntry) => boolean) => included.filter(test).length
  const parts = [
    [count((entry) => entry.breaking), 'breaking change'],
    [count((entry) => !entry.breaking && entry.section === 'features'), 'feature'],
    [count((entry) => !entry.breaking && entry.section === 'fixes'), 'fix'],
    [
      count((entry) => !entry.breaking && entry.section === 'performance'),
      'performance improvement',
    ],
  ] as const
  const counted = parts.filter(([n]) => n > 0).map(([n, word]) => plural(n, word))
  const others = included.length - parts.reduce((sum, [n]) => sum + n, 0)
  if (others > 0) counted.push(plural(others, 'other change'))
  const tickets = [...new Set(included.flatMap((entry) => entry.tickets))]
  const highlights = included
    .filter((entry) => entry.breaking || entry.section === 'features')
    .slice(0, 5)
    .map((entry) => `- ${entry.scope ? `**${entry.scope}:** ` : ''}${entry.text}`)
  return [
    `${counted.join(', ')}${tickets.length ? ` across ${plural(tickets.length, 'ticket')}` : ''}.`,
    ...(highlights.length ? ['', ...highlights] : []),
  ].join('\n')
}
