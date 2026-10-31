import {
  type Block,
  type Cell,
  type Column,
  defineAnalysis,
  type GraphEdge,
  type GraphNode,
  type Issue,
  type Metric,
  metric,
  type Report,
  type Section,
  type TimelineItem,
  type Tone,
} from '@holtkeeper/report'

import {
  type ComponentSummary,
  type StackCell,
  type Support,
  stackTotals,
  summarizeStack,
  type UsageStatus,
} from './assess.ts'
import { stackDataSchema } from './schema.ts'
import type { ComponentKind, StackData, UsageVia } from './types.ts'
import { majorOf } from './version.ts'

/** Component columns shown in the version matrix; the components table lists all of them. */
const matrixLimit = 40
/** Edges drawn in the map before it keeps only components several repositories share. */
const mapEdgeLimit = 300
/** Rows of the usages table. */
const usageLimit = 1000

const kindLabels: Record<ComponentKind, string> = {
  runtime: 'Runtimes',
  'package-manager': 'Package managers',
  service: 'Services',
  os: 'Base systems',
  image: 'Other images',
  tool: 'Other tools',
}

const kindOrder = Object.keys(kindLabels)

/** Shortest trailing path segments that keep image names apart, e.g. `bet-service` for a registry path. */
function columnLabels(names: readonly string[]): string[] {
  const parts = names.map((name) => name.split('/'))
  return parts.map((segments) => {
    for (let take = 1; take < segments.length; take++) {
      const label = segments.slice(-take).join('/')
      if (parts.every((other) => other === segments || other.slice(-take).join('/') !== label))
        return label
    }
    return segments.join('/')
  })
}

const viaLabels: Record<UsageVia, string> = {
  'version-file': 'version file',
  dockerfile: 'Dockerfile',
  compose: 'compose',
  ci: 'CI',
  deploy: 'deployment',
}

const supportLabels: Record<Support, string> = {
  lts: 'LTS',
  active: 'supported',
  'eol-soon': 'end of life soon',
  eol: 'end of life',
  unknown: 'support unknown',
}

const supportTones: Record<Support, Tone> = {
  lts: 'good',
  active: 'good',
  'eol-soon': 'warning',
  eol: 'bad',
  unknown: 'neutral',
}

const lagLabels: Record<UsageStatus['lag'], string> = {
  current: 'latest',
  ahead: 'newer than latest',
  patch: 'patch behind',
  minor: 'minor behind',
  major: 'major behind',
  unknown: 'latest unknown',
  floating: 'no version pinned',
}

const lagTones: Record<UsageStatus['lag'], Tone> = {
  current: 'good',
  ahead: 'info',
  patch: 'neutral',
  minor: 'info',
  major: 'warning',
  unknown: 'neutral',
  floating: 'neutral',
}

type Bucket = 'eol' | 'soon' | 'major' | 'behind' | 'current' | 'floating' | 'unknown'

function bucketOf(status: UsageStatus): Bucket {
  if (status.support === 'eol') return 'eol'
  if (status.support === 'eol-soon') return 'soon'
  if (status.lag === 'major') return 'major'
  if (status.lag === 'minor' || status.lag === 'patch') return 'behind'
  if (status.lag === 'current' || status.lag === 'ahead') return 'current'
  return status.lag === 'floating' ? 'floating' : 'unknown'
}

const toneOf = (status: UsageStatus): Tone =>
  status.support === 'eol' || status.support === 'eol-soon'
    ? supportTones[status.support]
    : lagTones[status.lag]

const prev = (value: number | undefined) => (value === undefined ? {} : { previous: value })
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const warn = (value: number, entry: Metric, tone: Tone = 'warning'): Metric =>
  value > 0 ? { ...entry, tone } : entry

function metricsOf(data: StackData, previous?: StackData): Metric[] {
  const now = stackTotals(data)
  const before = previous ? stackTotals(previous) : undefined
  const down = (value: number | undefined) => ({ ...prev(value), better: 'down' as const })
  return [
    metric('repos', 'Repositories', now.repos, prev(before?.repos)),
    metric('components', 'Components', now.components, prev(before?.components)),
    warn(
      now.reposOnEol,
      metric(
        'eol',
        'Repositories on end-of-life versions',
        now.reposOnEol,
        down(before?.reposOnEol),
      ),
      'bad',
    ),
    warn(
      now.reposEolSoon,
      metric('eol-soon', 'Repositories with end of life soon', now.reposEolSoon, {
        ...down(before?.reposEolSoon),
        hint: `within ${data.soonDays} days`,
      }),
    ),
    warn(
      now.reposBehindMajor,
      metric(
        'behind-major',
        'Repositories behind a major',
        now.reposBehindMajor,
        down(before?.reposBehindMajor),
      ),
    ),
    warn(
      now.multiMajor,
      metric(
        'multi-major',
        'Components in several majors',
        now.multiMajor,
        down(before?.multiMajor),
      ),
    ),
    metric('floating', 'Unpinned versions', now.floating, down(before?.floating)),
  ]
}

const readableRepos = (data: StackData) =>
  data.repos.filter((repo) => !repo.error && !repo.archived).map((repo) => repo.path)

const cycleKey = (summary: ComponentSummary, cycle: string) => `${summary.component.id}@${cycle}`

function cellHint(cell: StackCell): string {
  const { status } = cell
  return [
    status.cycle
      ? `${supportLabels[status.support]}${status.eolDate ? ` (until ${status.eolDate})` : ''}`
      : undefined,
    lagLabels[status.lag],
    status.cycleLatest ? `line latest ${status.cycleLatest}` : undefined,
    cell.versions.length > 1 ? `versions: ${cell.versions.join(', ')}` : undefined,
    cell.files.join(', '),
  ]
    .filter(Boolean)
    .join(' · ')
}

function matrixCell(cell: StackCell | undefined): Cell {
  if (!cell) return null
  const text =
    (cell.usage.version ?? cell.usage.declared) +
    (cell.versions.length > 1 ? ` (+${cell.versions.length - 1})` : '')
  return { text, tone: toneOf(cell.status), hint: cellHint(cell) }
}

/** Release lines in use that have ended or end soon, by `component@line`. */
const failingLines = (list: ComponentSummary[]) =>
  new Map(
    list.flatMap((summary) =>
      summary.cycles
        .filter((entry) => entry.support === 'eol' || entry.support === 'eol-soon')
        .map((entry) => [cycleKey(summary, entry.cycle.cycle), { summary, entry }] as const),
    ),
  )

function lifecycleSection(
  data: StackData,
  summaries: ComponentSummary[],
  previous: ComponentSummary[] | undefined,
  compareTo?: string,
): Section {
  const now = failingLines(summaries)
  const before = previous ? failingLines(previous) : undefined
  const items: Issue[] = [...now].map(([id, { summary, entry }]) => {
    const { component } = summary
    const date = typeof entry.cycle.eol === 'string' ? entry.cycle.eol : undefined
    const title =
      entry.support === 'eol'
        ? `${component.name} ${entry.cycle.cycle} reached end of life${date ? ` on ${date}` : ''}`
        : `${component.name} ${entry.cycle.cycle} reaches end of life on ${date}`
    const targets = [
      component.latestLts ? `latest LTS ${component.latestLts}` : undefined,
      component.latest ? `latest ${component.latest}` : undefined,
    ].filter(Boolean)
    return {
      id,
      tone: supportTones[entry.support],
      title,
      detail: `${plural(entry.repos.length, 'repository', 'repositories')}: ${entry.repos.join(', ')}${targets.length ? `\nUpgrade to ${targets.join(' or ')}.` : ''}`,
      tags: [kindLabels[component.kind], ...(before && !before.has(id) ? ['new'] : [])],
    }
  })
  if (before)
    for (const [id, { summary, entry }] of before)
      if (!now.has(id))
        items.push({
          id: `resolved:${id}`,
          tone: 'good',
          title: `No repository uses ${summary.component.name} ${entry.cycle.cycle} any more`,
          tags: [kindLabels[summary.component.kind], 'resolved'],
        })
  items.sort((a, b) =>
    a.tone === b.tone
      ? a.title.localeCompare(b.title)
      : a.tone === 'bad'
        ? -1
        : b.tone === 'bad'
          ? 1
          : 0,
  )

  const timeline: TimelineItem[] = summaries
    .flatMap((summary) =>
      summary.cycles
        .filter((entry) => typeof entry.cycle.eol === 'string')
        .map((entry) => ({
          id: cycleKey(summary, entry.cycle.cycle),
          at: String(entry.cycle.eol),
          title: `${summary.component.name} ${entry.cycle.cycle}`,
          subtitle: `${supportLabels[entry.support]} · ${plural(entry.repos.length, 'repository', 'repositories')}: ${entry.repos.join(', ')}`,
          tone: supportTones[entry.support],
          tags: [kindLabels[summary.component.kind]],
        })),
    )
    .toSorted((a, b) => a.at.localeCompare(b.at))

  const blocks: Block[] = [
    items.length
      ? { type: 'issues', title: 'Release lines past or near end of life', items }
      : {
          type: 'markdown',
          text: `No repository uses a release line that has ended or ends within ${data.soonDays} days.`,
        },
  ]
  if (timeline.length)
    blocks.push({ type: 'timeline', title: 'End of life of release lines in use', items: timeline })
  return {
    id: 'lifecycle',
    title: 'End of life',
    description: `Release lines from endoflife.date, judged on ${data.checkedAt.slice(0, 10)}; lines ending within ${data.soonDays} days count as soon.${previous ? ` New and resolved lines are against ${compareTo ?? 'the previous analysis'}.` : ''}`,
    blocks,
  }
}

function versionsSection(data: StackData, summaries: ComponentSummary[]): Section {
  if (summaries.length === 0)
    return {
      id: 'versions',
      title: 'Versions',
      blocks: [{ type: 'markdown', text: 'No runtimes, package managers or images were found.' }],
    }
  const shown = summaries.slice(0, matrixLimit)
  const kinds = [...new Set(shown.map((summary) => summary.component.kind))].toSorted(
    (a, b) => kindOrder.indexOf(a) - kindOrder.indexOf(b),
  )
  const matrices: Block[] = kinds.map((kind) => {
    const members = shown.filter((summary) => summary.component.kind === kind)
    const labels = columnLabels(members.map((summary) => summary.component.name))
    const columns: Column[] = [
      { key: 'repo', label: 'Repository', format: 'code' },
      ...members.map((summary, index) => ({
        key: summary.component.id,
        label: labels[index] ?? summary.component.name,
        ...(labels[index] === summary.component.name ? {} : { hint: summary.component.name }),
        unit: 'version' as const,
      })),
    ]
    const rows = readableRepos(data)
      .filter((repo) => members.some((summary) => summary.cells.has(repo)))
      .map((repo) => {
        const row: Record<string, Cell> = { repo }
        for (const summary of members)
          row[summary.component.id] = matrixCell(summary.cells.get(repo))
        return row
      })
    return { type: 'table', title: kindLabels[kind], columns, rows }
  })
  const spread = summaries.map((summary) => {
    const counts: Record<Bucket, number> = {
      current: 0,
      behind: 0,
      major: 0,
      soon: 0,
      eol: 0,
      floating: 0,
      unknown: 0,
    }
    for (const cell of summary.cells.values()) counts[bucketOf(cell.status)]++
    return { component: summary.component.name, ...counts }
  })
  const blocks: Block[] = [
    ...matrices,
    {
      type: 'chart',
      title: 'Spread per component',
      chart: 'stacked-bar',
      unit: 'count',
      x: 'component',
      series: [
        { key: 'current', label: 'Latest', tone: 'good' },
        { key: 'behind', label: 'Minor or patch behind', tone: 'info' },
        { key: 'major', label: 'Major behind', tone: 'warning' },
        { key: 'soon', label: 'End of life soon', tone: 'warning' },
        { key: 'eol', label: 'End of life', tone: 'bad' },
        { key: 'floating', label: 'Not pinned', tone: 'neutral' },
        { key: 'unknown', label: 'Unknown', tone: 'neutral' },
      ],
      data: spread,
    },
  ]
  if (summaries.length > shown.length)
    blocks.push({
      type: 'markdown',
      text: `The tables show the ${shown.length} most used of ${summaries.length} components; the Components section lists all of them.`,
    })
  return {
    id: 'versions',
    title: 'Versions',
    description:
      'One table per kind of component, listing only repositories that use one. Each cell is the most worrying version a repository names: end of life first, then the largest lag behind the latest release. Floating versions (`22`, `3.12`) are compared only as far as they are written.',
    blocks,
  }
}

function componentsSection(
  summaries: ComponentSummary[],
  previous: ComponentSummary[] | undefined,
  compareTo?: string,
): Section {
  const before = new Map(previous?.map((summary) => [summary.component.id, summary]))
  const columns: Column[] = [
    { key: 'component', label: 'Component', format: 'code' },
    { key: 'kind', label: 'Kind' },
    { key: 'latest', label: 'Latest', unit: 'version' },
    { key: 'lts', label: 'Latest LTS', unit: 'version' },
    { key: 'versions', label: 'Versions in use', format: 'tags' },
    { key: 'lines', label: 'Release lines', format: 'tags' },
    { key: 'repos', label: 'Repositories', unit: 'count', align: 'end' },
    { key: 'eol', label: 'End of life', unit: 'count', align: 'end' },
    { key: 'major', label: 'Major behind', unit: 'count', align: 'end' },
    { key: 'floating', label: 'Not pinned', unit: 'count', align: 'end' },
    ...(previous
      ? [
          {
            key: 'delta',
            label: `Δ end of life${compareTo ? ` since ${compareTo}` : ''}`,
            format: 'delta' as const,
            better: 'down' as const,
            align: 'end' as const,
          },
        ]
      : []),
  ]
  const rows = summaries.map((summary) => {
    const { component } = summary
    const old = before.get(component.id)
    const worst: Tone | undefined = summary.cycles.some((entry) => entry.support === 'eol')
      ? 'bad'
      : summary.cycles.some((entry) => entry.support === 'eol-soon')
        ? 'warning'
        : undefined
    return {
      component: component.source
        ? { text: component.name, hint: `latest from ${component.source}` }
        : component.name,
      kind: kindLabels[component.kind],
      latest: component.latest ?? null,
      lts: component.latestLts ?? null,
      versions: summary.versions.join(', '),
      lines: worst
        ? {
            text: summary.cycles.map((entry) => entry.cycle.cycle).join(', '),
            tone: worst,
            hint: summary.cycles
              .map((entry) => `${entry.cycle.cycle}: ${supportLabels[entry.support]}`)
              .join('; '),
          }
        : summary.cycles.map((entry) => entry.cycle.cycle).join(', '),
      repos: summary.cells.size,
      eol: summary.eolRepos.length,
      major: summary.behindMajorRepos.length,
      floating: summary.floatingRepos.length,
      ...(previous ? { delta: old ? summary.eolRepos.length - old.eolRepos.length : null } : {}),
    }
  })
  return {
    id: 'components',
    title: 'Components',
    description:
      'Runtimes, package managers, services, base systems, other images and tools, with their latest releases.',
    blocks: [
      rows.length
        ? { type: 'table', columns, rows, groupBy: 'kind' }
        : { type: 'markdown', text: 'No components were found.' },
    ],
  }
}

const lineOf = (cell: StackCell) =>
  cell.status.cycle?.cycle ??
  (cell.usage.version ? majorOf(cell.usage.version) : cell.usage.declared)

const linksOf = (list: ComponentSummary[]) =>
  list.flatMap((summary) => [...summary.cells].map(([repo, cell]) => ({ summary, repo, cell })))

function mapSection(data: StackData, summaries: ComponentSummary[]): Section | undefined {
  let links = linksOf(summaries)
  const limited = links.length > mapEdgeLimit
  if (limited)
    links = linksOf(summaries.filter((summary) => summary.cells.size > 1)).slice(0, mapEdgeLimit)
  if (links.length === 0) return undefined

  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const repoCounts = Map.groupBy(links, (link) => link.repo)
  for (const [repo, list] of repoCounts)
    nodes.set(`repo:${repo}`, {
      id: `repo:${repo}`,
      label: repo,
      group: 'Repositories',
      size: list.length,
    })
  const versions = new Map<string, Set<string>>()
  for (const { summary, repo, cell } of links) {
    const line = lineOf(cell)
    const id = `line:${summary.component.id}@${line}`
    const node = nodes.get(id)
    if (node) node.size = (node.size ?? 0) + 1
    else
      nodes.set(id, {
        id,
        label: `${summary.component.name} ${line}`,
        group: kindLabels[summary.component.kind],
        tone: toneOf(cell.status),
        size: 1,
        ...(cell.status.cycle
          ? {
              detail: `${supportLabels[cell.status.support]}${cell.status.eolDate ? ` until ${cell.status.eolDate}` : ''}`,
            }
          : {}),
      })
    versions.set(id, (versions.get(id) ?? new Set()).add(cell.usage.version ?? cell.usage.declared))
    edges.push({
      from: `repo:${repo}`,
      to: id,
      tone: toneOf(cell.status),
      ...(cell.status.lag === 'floating' ? { dashed: true } : {}),
    })
  }
  for (const [id, set] of versions) {
    const node = nodes.get(id)
    if (!node) continue
    const list = [...set].join(', ')
    node.detail = node.detail ? `${node.detail} · ${list}` : list
  }
  const blocks: Block[] = [
    {
      type: 'graph',
      title: 'Repositories and the release lines they share',
      nodes: [...nodes.values()],
      edges,
      layout: 'force',
    },
  ]
  if (limited)
    blocks.push({
      type: 'markdown',
      text: `The fleet has too many links to draw; the map keeps components at least two repositories share (${edges.length} links).`,
    })
  return {
    id: 'map',
    title: 'Map',
    description: `Each repository links to the release lines it uses; ${readableRepos(data).length > 1 ? 'repositories on the same line meet at one node.' : 'more repositories would meet at shared lines.'}`,
    blocks,
  }
}

function usagesSection(summaries: ComponentSummary[]): Section | undefined {
  const rows = summaries.flatMap((summary) =>
    summary.component.usages.map((usage) => ({
      component: summary.component.name,
      repo: usage.repo,
      version: usage.version ?? null,
      declared: usage.image ?? usage.declared,
      file: usage.file,
      via: viaLabels[usage.via],
    })),
  )
  if (rows.length === 0) return undefined
  const blocks: Block[] = [
    {
      type: 'table',
      columns: [
        { key: 'component', label: 'Component' },
        { key: 'repo', label: 'Repository', format: 'code' },
        { key: 'version', label: 'Version', unit: 'version' },
        { key: 'declared', label: 'As written', format: 'code' },
        { key: 'file', label: 'File', format: 'code' },
        { key: 'via', label: 'Source' },
      ],
      rows: rows.slice(0, usageLimit),
      groupBy: 'component',
    },
  ]
  if (rows.length > usageLimit)
    blocks.push({ type: 'markdown', text: `Showing ${usageLimit} of ${rows.length} usages.` })
  return {
    id: 'usages',
    title: 'Where versions are set',
    description:
      'Every place a version is named: version files, Dockerfiles, compose files, CI configs and deployment manifests.',
    blocks,
  }
}

function notesSection(data: StackData): Section | undefined {
  const items: Issue[] = [
    ...data.repos
      .filter((repo) => repo.error)
      .map((repo) => ({
        id: `repo:${repo.path}`,
        tone: 'bad' as const,
        title: `${repo.path} could not be read`,
        detail: repo.error ?? '',
      })),
    ...data.repos
      .filter((repo) => repo.archived)
      .map((repo) => ({
        id: `archived:${repo.path}`,
        tone: 'neutral' as const,
        title: `${repo.path} is archived and was skipped`,
      })),
    ...data.notes.map((note, index) => ({
      id: `note:${index}`,
      tone: 'warning' as const,
      title: note.repo ? `${note.repo}: ${note.message}` : note.message,
    })),
  ]
  return items.length
    ? { id: 'notes', title: 'Notes', blocks: [{ type: 'issues', items }] }
    : undefined
}

/** The `stack` analysis: runtimes, package managers and images across the repositories of one group. */
export const stackAnalysis = defineAnalysis<StackData>({
  kind: 'stack',
  label: 'Tech stack',
  schema: stackDataSchema,
  summarize: (data) => metricsOf(data),
  toReport(current, previous): Report {
    const data = current.data
    const before = previous?.data
    const compareTo = previous ? (previous.ref ?? previous.createdAt.slice(0, 10)) : undefined
    const summaries = summarizeStack(data)
    const previousSummaries = before ? summarizeStack(before) : undefined
    const optional = [
      mapSection(data, summaries),
      usagesSection(summaries),
      notesSection(data),
    ].filter((section): section is Section => section !== undefined)
    return {
      kind: 'stack',
      title: `Tech stack: ${data.group}`,
      subtitle: `${plural(readableRepos(data).length, 'repository', 'repositories')}, ${plural(data.components.length, 'component', 'components')}`,
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(compareTo ? { compareTo } : {}),
      },
      generatedAt: current.createdAt,
      metrics: metricsOf(data, before),
      sections: [
        lifecycleSection(data, summaries, previousSummaries, compareTo),
        versionsSection(data, summaries),
        componentsSection(summaries, previousSummaries, compareTo),
        ...optional,
      ],
    }
  },
})
