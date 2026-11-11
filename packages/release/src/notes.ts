import { bumpFor } from '@holtkeeper/commit-conventions'

import { type ParsedReleaseCommit, parseCommit } from './conventional.ts'
import type { ChangelogLinks } from './links.ts'
import { type CommitCluster, groupCommits, sectionOrder, sectionTitles } from './sections.ts'
import type { Bump, ReleaseSettings } from './settings.ts'
import type { BumpReason, ReleaseCommit, ReleaseEdits, ReleaseEntry } from './types.ts'
import { maxBump } from './version.ts'

const toParsed = (commit: ReleaseCommit): ParsedReleaseCommit => ({
  ...commit,
  parsed: parseCommit(commit.subject, commit.body),
})

const entryId = (key: string) => Bun.hash(key).toString(36)

const withoutTrailingRefs = (title: string) =>
  title.replace(/\s*\((?:[#!]\d+(?:,\s*)?)+\)\s*$/u, '').trim() || title

/** Shas of commits that are reverted by another commit of the same list, plus those reverts. */
function revertPairs(commits: readonly ParsedReleaseCommit[]): Set<string> {
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
  if (cluster.commits.length === 0) return true
  if (cluster.commits.every((commit) => commit.parsed.wip)) return true
  return cluster.type !== undefined && settings.excludeTypes.includes(cluster.type)
}

const clusterBump = (cluster: CommitCluster): Bump =>
  cluster.commits.reduce<Bump>(
    (max, commit) => maxBump(max, bumpFor({ title: commit.subject, body: commit.body })),
    cluster.breaking ? 'major' : 'none',
  )

/**
 * Changelog entries of a range: commits with the same type, scope and message are one entry, so
 * repeated messages appear once; merge commits are left out. `excludeTypes` and WIP commits mark
 * entries left out (`excludedBy: 'rule'`), commits reverted within the range drop out with their
 * revert, and `edits` apply last: a person's choice beats the rules. Each entry carries the bump
 * its commits call for (`bumpFor` of the commit conventions). Entries keep the order of
 * `sectionOrder`.
 */
export function buildEntries(
  commits: readonly ReleaseCommit[],
  settings: ReleaseSettings['changelog'],
  edits: ReleaseEdits = {},
): ReleaseEntry[] {
  const parsed = commits.map(toParsed)
  const reverted = revertPairs(parsed)
  const clusters = groupCommits(parsed).sections.flatMap((section) =>
    section.scopes.flatMap((scope) => scope.clusters),
  )

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
        bump: clusterBump(cluster),
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
 * The bump the included entries call for, each by `bumpFor` of the commit conventions (breaking →
 * major, feat → minor, anything else → patch). While the major version is 0, breaking changes
 * bump the minor version. `none` when nothing is included.
 */
export function suggestBump(
  entries: readonly ReleaseEntry[],
  options: { current?: string } = {},
): { bump: Bump; reasons: BumpReason[] } {
  const included = entries.filter((entry) => entry.included)
  if (included.length === 0) return { bump: 'none', reasons: [] }
  const zeroMajor = options.current?.startsWith('0.') === true
  const groups = new Map<string, { bump: Bump; ids: string[] }>()
  for (const entry of included) {
    const breaking = entry.bump === 'major'
    const bump = breaking ? (zeroMajor ? 'minor' : 'major') : maxBump(entry.bump, 'patch')
    const key = breaking ? '\u0000' : (entry.type ?? '')
    const group = groups.get(key) ?? { bump, ids: [] }
    group.ids.push(entry.id)
    groups.set(key, group)
  }
  const reasons = [...groups].map(([key, group]) => ({
    bump: group.bump,
    because:
      key === '\u0000'
        ? `${plural(group.ids.length, 'breaking change')}${zeroMajor ? ' while the major version is 0' : ''}`
        : plural(group.ids.length, key || 'other change'),
    entries: group.ids,
  }))
  return {
    bump: reasons.reduce<Bump>((max, reason) => maxBump(max, reason.bump), 'none'),
    reasons: reasons.toSorted((a, b) => rank(b.bump) - rank(a.bump)),
  }
}

const rank = (bump: Bump) => ['none', 'patch', 'minor', 'major'].indexOf(bump)

const shortSha = (sha: string) => sha.slice(0, 8)

const link = (label: string, url: string | undefined) => (url ? `[${label}](${url})` : label)

function references(entry: ReleaseEntry, links: ChangelogLinks | undefined): string {
  const refs = [
    ...entry.tickets.map((ticket) => link(ticket, links?.ticket(ticket))),
    ...entry.mergeRequests.map((n) => link(`!${n}`, links?.mergeRequest(n))),
  ]
  if (refs.length === 0 && entry.commits[0])
    refs.push(link(shortSha(entry.commits[0].sha), links?.commit(entry.commits[0].sha)))
  return refs.length ? ` (${refs.join(', ')})` : ''
}

const line = (entry: ReleaseEntry, links: ChangelogLinks | undefined) =>
  `- ${entry.scope ? `**${entry.scope}:** ` : ''}${entry.text}${references(entry, links)}`

/**
 * Markdown of the included entries: one `###` heading per section in `sectionOrder`, breaking
 * changes first, each line with its scope and links to tickets and merge requests (or the commit).
 */
export function renderChangelog(entries: readonly ReleaseEntry[], links?: ChangelogLinks): string {
  const groups = new Map<string, ReleaseEntry[]>()
  for (const entry of entries) {
    if (!entry.included) continue
    const title = sectionTitles[entry.section]
    groups.set(title, [...(groups.get(title) ?? []), entry])
  }
  return [...groups]
    .map(([title, list]) => `### ${title}\n\n${list.map((entry) => line(entry, links)).join('\n')}`)
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
