import {
  type Block,
  type Cell,
  defineAnalysis,
  type Issue,
  type Metric,
  metric,
  type Report,
  type Section,
  type TimelineItem,
  type Tone,
} from '@holtkeeper/report'

import {
  type ChangelogGroups,
  type CommitCluster,
  groupCommits,
  type SectionId,
  sectionTitles,
} from './group.ts'
import { type ChangelogLinks, linksFromTemplates } from './links.ts'
import { changelogDataSchema } from './schema.ts'
import type { ChangelogCommit, ChangelogData } from './types.ts'

const DAY = 86_400_000

const sectionTones: Partial<Record<SectionId, Tone>> = {
  breaking: 'bad',
  features: 'good',
  fixes: 'info',
  performance: 'good',
  reverts: 'warning',
}

const short = (sha: string) => sha.slice(0, 8)

function totals(data: ChangelogData, groups: ChangelogGroups) {
  const regular = data.commits.filter((commit) => !commit.parsed.merge)
  const summed = regular.reduce(
    (sum, commit) => ({
      files: sum.files + commit.stats.files,
      insertions: sum.insertions + commit.stats.insertions,
      deletions: sum.deletions + commit.stats.deletions,
    }),
    { files: 0, insertions: 0, deletions: 0 },
  )
  const entries = (id: SectionId) =>
    groups.sections.find((section) => section.id === id)?.scopes.flatMap((s) => s.clusters) ?? []
  return {
    commits: regular.length,
    merges: data.commits.length - regular.length,
    contributors: groups.contributors.filter((person) => person.commits > 0).length,
    features: entries('features').length,
    fixes: entries('fixes').length,
    breaking: entries('breaking').length,
    diff: data.diff ?? summed,
    days: data.from
      ? Math.round((Date.parse(data.to.date) - Date.parse(data.from.date)) / DAY)
      : undefined,
  }
}

const prev = (value: number | undefined) => (value === undefined ? {} : { previous: value })

function metricsOf(data: ChangelogData, previous?: ChangelogData): Metric[] {
  const now = totals(data, groupCommits(data.commits))
  const before = previous ? totals(previous, groupCommits(previous.commits)) : undefined
  const list = [
    metric('commits', 'Commits', now.commits, {
      ...prev(before?.commits),
      ...(now.merges ? { hint: `${now.merges} merge commits not counted` } : {}),
    }),
    metric('contributors', 'Contributors', now.contributors, prev(before?.contributors)),
    metric('features', 'Features', now.features, { ...prev(before?.features), better: 'up' }),
    metric('fixes', 'Fixes', now.fixes, prev(before?.fixes)),
    {
      ...metric('breaking', 'Breaking changes', now.breaking, prev(before?.breaking)),
      ...(now.breaking ? { tone: 'bad' as const } : {}),
    },
    metric('files', 'Files changed', now.diff.files, {
      ...prev(before?.diff.files),
      ...(data.diff ? {} : { hint: 'summed per commit' }),
    }),
    {
      ...metric('insertions', 'Lines added', now.diff.insertions, prev(before?.diff.insertions)),
      tone: 'good' as const,
    },
    {
      ...metric('deletions', 'Lines removed', now.diff.deletions, prev(before?.diff.deletions)),
      tone: 'bad' as const,
    },
  ]
  if (now.days !== undefined) {
    list.push(
      metric('days', 'Days since previous release', now.days, {
        ...prev(before?.days),
        hint: `since ${data.from?.name}`,
      }),
    )
  }
  return list
}

function mrLabel(number: number, links?: ChangelogLinks) {
  return links && !links.templates.mergeRequest.includes('merge_requests')
    ? `#${number}`
    : `!${number}`
}

function clusterTitle(cluster: CommitCluster) {
  const prefix = cluster.type
    ? `${cluster.type}${cluster.scope ? `(${cluster.scope})` : ''}${cluster.breaking ? '!' : ''}: `
    : ''
  const count = cluster.commits.length > 1 ? ` ×${cluster.commits.length}` : ''
  return `${prefix}${cluster.title}${count}`
}

function commitItem(commit: ChangelogCommit, links?: ChangelogLinks): TimelineItem {
  return {
    id: commit.sha,
    at: commit.date,
    title: commit.subject,
    subtitle: `${commit.author.name} · ${short(commit.sha)}`,
    ...(links ? { href: links.commit(commit.sha) } : {}),
  }
}

function clusterItem(cluster: CommitCluster, links?: ChangelogLinks): TimelineItem {
  const newest = cluster.commits[0]!
  const tone = sectionTones[cluster.section]
  const tags = [
    ...(cluster.scope ? [cluster.scope] : []),
    ...cluster.tickets,
    ...cluster.mergeRequests.map((n) => mrLabel(n, links)),
  ]
  const shas = cluster.commits.length > 1 ? `${cluster.commits.length} commits` : short(newest.sha)
  return {
    id: newest.sha,
    at: cluster.lastAt,
    title: clusterTitle(cluster),
    subtitle: `${cluster.authors.join(', ')} · ${shas}`,
    ...(links ? { href: links.commit(newest.sha) } : {}),
    ...(tone ? { tone } : {}),
    ...(tags.length ? { tags } : {}),
    ...(cluster.commits.length > 1
      ? { children: cluster.commits.map((commit) => commitItem(commit, links)) }
      : {}),
  }
}

function highlights(groups: ChangelogGroups, links?: ChangelogLinks): Issue[] {
  const issues: Issue[] = []
  for (const section of groups.sections) {
    if (section.id !== 'breaking' && section.id !== 'reverts') continue
    for (const cluster of section.scopes.flatMap((scope) => scope.clusters)) {
      const newest = cluster.commits[0]!
      const reverted = newest.parsed.revert?.sha
      const detail =
        section.id === 'breaking'
          ? newest.parsed.breakingNote
          : reverted
            ? `Reverts ${short(reverted)}`
            : undefined
      issues.push({
        id: newest.sha,
        tone: section.id === 'breaking' ? 'bad' : 'warning',
        title: section.id === 'breaking' ? clusterTitle(cluster) : `Revert: ${cluster.title}`,
        ...(detail ? { detail } : {}),
        ...(links ? { href: links.commit(reverted ?? newest.sha) } : {}),
        tags: [section.id === 'breaking' ? 'breaking' : 'revert', ...cluster.tickets],
      })
    }
  }
  return issues
}

function activity(data: ChangelogData, groups: ChangelogGroups): Block | undefined {
  const regular = groups.sections.flatMap((section) =>
    section.scopes.flatMap((scope) =>
      scope.clusters.flatMap((cluster) =>
        cluster.commits.map((commit) => ({ section: section.id, commit })),
      ),
    ),
  )
  if (regular.length === 0) return undefined
  const days = regular.map(({ commit }) => Date.parse(commit.date.slice(0, 10)))
  const first = Math.min(...days)
  const last = Math.max(...days)
  const weekly = (last - first) / DAY > 62
  const bucketOf = (time: number) => {
    if (!weekly) return new Date(time).toISOString().slice(0, 10)
    const weekday = (new Date(time).getUTCDay() + 6) % 7
    return new Date(time - weekday * DAY).toISOString().slice(0, 10)
  }
  const rows = new Map<string, Record<string, string | number>>()
  for (let time = first; time <= last; time += weekly ? DAY * 7 : DAY) {
    const bucket = bucketOf(time)
    rows.set(bucket, { [weekly ? 'week' : 'day']: bucket })
  }
  const lastBucket = bucketOf(last)
  if (!rows.has(lastBucket)) rows.set(lastBucket, { [weekly ? 'week' : 'day']: lastBucket })
  for (const [index, { section }] of regular.entries()) {
    const row = rows.get(bucketOf(days[index]!))!
    row[section] = Number(row[section] ?? 0) + 1
  }
  const present = groups.sections.map((section) => section.id)
  for (const row of rows.values()) for (const id of present) row[id] ??= 0
  return {
    type: 'chart',
    title: `Commits per ${weekly ? 'week' : 'day'} by type`,
    chart: 'stacked-bar',
    unit: 'count',
    x: weekly ? 'week' : 'day',
    series: present.map((id) => {
      const tone = sectionTones[id]
      return tone
        ? { key: id, label: sectionTitles[id], tone }
        : { key: id, label: sectionTitles[id] }
    }),
    data: [...rows.values()],
  }
}

function referencesTable(groups: ChangelogGroups, links?: ChangelogLinks): Block | undefined {
  const rows: Record<string, Cell>[] = [
    ...groups.mergeRequests.map((request) => {
      const href = links?.mergeRequest(request.number)
      const text = mrLabel(request.number, links)
      return {
        ref: href ? { text, href } : text,
        kind: 'Merge request',
        title: request.title,
        commits: request.shas.length,
      }
    }),
    ...groups.tickets.map((ticket) => {
      const href = links?.ticket(ticket.id)
      return {
        ref: href ? { text: ticket.id, href } : ticket.id,
        kind: 'Ticket',
        title: ticket.titles.join('; '),
        commits: ticket.shas.length,
      }
    }),
  ]
  if (rows.length === 0) return undefined
  return {
    type: 'table',
    columns: [
      { key: 'ref', label: 'Reference', format: 'code' },
      { key: 'kind', label: 'Kind' },
      { key: 'title', label: 'Title' },
      { key: 'commits', label: 'Commits', unit: 'count', align: 'end' },
    ],
    rows,
    groupBy: 'kind',
  }
}

const topFiles = 20

function filesTable(data: ChangelogData): Block | undefined {
  if (!data.files?.length) return undefined
  return {
    type: 'table',
    title: `Top ${Math.min(topFiles, data.files.length)} of ${data.files.length}${data.filesTruncated ? '+' : ''} files`,
    columns: [
      { key: 'path', label: 'File', format: 'code' },
      { key: 'status', label: 'Status' },
      { key: 'insertions', label: 'Added', unit: 'count', align: 'end' },
      { key: 'deletions', label: 'Removed', unit: 'count', align: 'end' },
    ],
    rows: data.files.slice(0, topFiles).map((file) => ({
      path: file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
      status: file.binary ? `${file.status ?? 'modified'} (binary)` : (file.status ?? null),
      insertions: file.insertions,
      deletions: file.deletions,
    })),
  }
}

function compareText(data: ChangelogData, links?: ChangelogLinks): string {
  const { from, to } = data
  if (!from) {
    const tag = links ? `[${to.name}](${links.tag(to.name)})` : `\`${to.name}\``
    return `First release ${tag}: the whole history up to \`${short(to.sha)}\`.`
  }
  const range = `${from.name}...${to.name}`
  const lines = [
    links
      ? `[Compare ${range}](${links.compare(from.name, to.name)})`
      : `\`git log ${from.name}..${to.name}\``,
  ]
  if (to.message) lines.push('', `> ${to.message.split('\n').join('\n> ')}`)
  return lines.join('\n')
}

function sectionsOf(
  data: ChangelogData,
  groups: ChangelogGroups,
  links?: ChangelogLinks,
): Section[] {
  const sections: Section[] = []

  const issues = highlights(groups, links)
  if (issues.length) {
    sections.push({
      id: 'highlights',
      title: 'Highlights',
      blocks: [{ type: 'issues', items: issues }],
    })
  }

  const timelines: Block[] = groups.sections.map((section) => ({
    type: 'timeline',
    title: section.title,
    items: section.scopes.flatMap((scope) =>
      scope.clusters.map((cluster) => clusterItem(cluster, links)),
    ),
  }))
  if (groups.merges.length) {
    timelines.push({
      type: 'timeline',
      title: 'Merge commits',
      items: groups.merges.map((cluster) => clusterItem(cluster, links)),
    })
  }
  sections.push({
    id: 'changelog',
    title: 'Changelog',
    description: 'Identical messages are collapsed into one entry.',
    blocks: timelines.length
      ? timelines
      : [{ type: 'markdown', text: 'No commits in this range.' }],
  })

  const chart = activity(data, groups)
  if (chart) sections.push({ id: 'activity', title: 'Activity', blocks: [chart] })

  if (groups.contributors.length) {
    sections.push({
      id: 'contributors',
      title: 'Contributors',
      blocks: [
        {
          type: 'table',
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'commits', label: 'Commits', unit: 'count', align: 'end' },
            { key: 'coAuthored', label: 'Co-authored', unit: 'count', align: 'end' },
            { key: 'insertions', label: 'Added', unit: 'count', align: 'end' },
            { key: 'deletions', label: 'Removed', unit: 'count', align: 'end' },
          ],
          rows: groups.contributors.map((person) => ({
            name: { text: person.name, hint: person.email },
            commits: person.commits,
            coAuthored: person.coAuthored,
            insertions: person.insertions,
            deletions: person.deletions,
          })),
        },
      ],
    })
  }

  const files = filesTable(data)
  if (files) {
    sections.push({
      id: 'files',
      title: 'Most changed files',
      ...(data.filesTruncated ? { description: 'Only the most changed files were recorded.' } : {}),
      blocks: [files],
    })
  }

  const references = referencesTable(groups, links)
  if (references) {
    sections.push({ id: 'references', title: 'Tickets and merge requests', blocks: [references] })
  }

  sections.push({
    id: 'compare',
    title: 'Compare',
    blocks: [{ type: 'markdown', text: compareText(data, links) }],
  })
  return sections
}

/** The `changelog` analysis kind: release notes built from commit history. */
export const changelogAnalysis = defineAnalysis<ChangelogData>({
  kind: 'changelog',
  label: 'Changelog',
  schema: changelogDataSchema,
  summarize: (data) => metricsOf(data),
  toReport(current, previous): Report {
    const data = current.data
    const links = data.links ? linksFromTemplates(data.links) : undefined
    const groups = groupCommits(data.commits)
    const commits = data.commits.filter((commit) => !commit.parsed.merge).length
    return {
      kind: 'changelog',
      title: `Changelog ${data.to.name}`,
      subtitle: `${data.from ? `${data.from.name} → ` : ''}${data.to.name} · ${commits} commits`,
      subject: {
        repo: current.repo,
        ref: data.to.name,
        ...(data.from ? { compareTo: data.from.name } : {}),
      },
      generatedAt: new Date().toISOString(),
      metrics: metricsOf(data, previous?.data),
      sections: sectionsOf(data, groups, links),
    }
  },
})
