import { changeDiff } from '@holtkeeper/changes'
import {
  type Block,
  type Cell,
  type Column,
  defineAnalysis,
  type Issue,
  type Metric,
  metric,
  type Report,
  type Section,
  type Tone,
} from '@holtkeeper/report'

import { fleetTotals, type LibrarySummary, type MatrixCell, summarizeLibrary } from './matrix.ts'
import { fleetDataSchema } from './schema.ts'
import { type Lag, parseVersion } from './semver.ts'
import type { FleetData, TemplateResult, TemplateStatus, TrackedLibrary } from './types.ts'

/** Library columns shown in the version matrix; the libraries table lists all of them. */
const matrixLimit = 40

const lagTones: Record<Lag, Tone> = {
  current: 'good',
  ahead: 'info',
  patch: 'neutral',
  minor: 'warning',
  major: 'bad',
  unknown: 'neutral',
}

const lagLabels: Record<Lag, string> = {
  current: 'latest',
  ahead: 'newer than latest',
  patch: 'patch behind',
  minor: 'minor behind',
  major: 'major behind',
  unknown: 'latest unknown',
}

const statusTones: Record<TemplateStatus, Tone> = {
  identical: 'good',
  drifted: 'warning',
  missing: 'bad',
  error: 'neutral',
}

const prev = (value: number | undefined) => (value === undefined ? {} : { previous: value })
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const warn = (value: number, entry: Metric): Metric =>
  value > 0 ? { ...entry, tone: 'warning' } : entry

function metricsOf(data: FleetData, previous?: FleetData): Metric[] {
  const now = fleetTotals(data)
  const before = previous ? fleetTotals(previous) : undefined
  return [
    metric('repos', 'Repositories', now.repos, prev(before?.repos)),
    metric('libraries', 'Tracked libraries', now.libraries, prev(before?.libraries)),
    warn(
      now.multiMajor,
      metric('multi-major', 'Libraries with several majors', now.multiMajor, {
        ...prev(before?.multiMajor),
        better: 'down',
      }),
    ),
    warn(
      now.reposBehindMajor,
      metric('behind-major', 'Repositories behind a major', now.reposBehindMajor, {
        ...prev(before?.reposBehindMajor),
        better: 'down',
      }),
    ),
    warn(
      now.drifted,
      metric('drifted', 'Drifted config files', now.drifted, {
        ...prev(before?.drifted),
        better: 'down',
      }),
    ),
    warn(
      now.missing,
      metric('missing', 'Missing config files', now.missing, {
        ...prev(before?.missing),
        better: 'down',
      }),
    ),
  ]
}

const readableRepos = (data: FleetData) =>
  data.repos.filter((repo) => !repo.error && !repo.archived).map((repo) => repo.path)

function matrixCell(cell: MatrixCell | undefined): Cell {
  if (!cell) return null
  const text =
    (cell.version ?? '?') + (cell.versions.length > 1 ? ` (+${cell.versions.length - 1})` : '')
  const hint = [
    lagLabels[cell.lag],
    cell.versions.length > 1 ? `versions: ${cell.versions.join(', ')}` : '',
    cell.manifests.join(', '),
  ]
    .filter(Boolean)
    .join(' · ')
  return { text, tone: lagTones[cell.lag], hint }
}

const majorsBehind = (cell: MatrixCell, latest: string | undefined) => {
  const now = cell.version ? parseVersion(cell.version) : undefined
  const last = latest ? parseVersion(latest) : undefined
  return now && last ? last.major - now.major : undefined
}

function versionsSection(data: FleetData, summaries: LibrarySummary[]): Section {
  if (summaries.length === 0)
    return {
      id: 'versions',
      title: 'Versions',
      blocks: [{ type: 'markdown', text: 'No libraries are tracked.' }],
    }
  const shown = summaries.slice(0, matrixLimit)
  const columns: Column[] = [
    { key: 'repo', label: 'Repository', format: 'code' },
    ...shown.map((summary, index) => ({
      key: `l${index}`,
      label: summary.library.name,
      unit: 'version' as const,
    })),
  ]
  const rows = readableRepos(data).map((repo) => {
    const row: Record<string, Cell> = { repo }
    shown.forEach((summary, index) => {
      row[`l${index}`] = matrixCell(summary.cells.get(repo))
    })
    return row
  })
  const spread = summaries.map((summary) => {
    const counts = {
      library: summary.library.name,
      current: 0,
      minor: 0,
      major1: 0,
      major2: 0,
      unknown: 0,
    }
    for (const cell of summary.cells.values()) {
      const behind = majorsBehind(cell, summary.library.latest)
      if (cell.lag === 'current' || cell.lag === 'ahead') counts.current++
      else if (cell.lag === 'unknown' || behind === undefined) counts.unknown++
      else if (behind >= 2) counts.major2++
      else if (behind === 1) counts.major1++
      else counts.minor++
    }
    return counts
  })
  const blocks: Block[] = [
    { type: 'table', title: 'Oldest version per repository', columns, rows },
    {
      type: 'chart',
      title: 'Version spread',
      chart: 'stacked-bar',
      unit: 'count',
      x: 'library',
      series: [
        { key: 'current', label: 'Latest', tone: 'good' },
        { key: 'minor', label: 'Minor or patch behind', tone: 'info' },
        { key: 'major1', label: '1 major behind', tone: 'warning' },
        { key: 'major2', label: '2+ majors behind', tone: 'bad' },
        { key: 'unknown', label: 'Unknown', tone: 'neutral' },
      ],
      data: spread,
    },
  ]
  if (summaries.length > shown.length)
    blocks.push({
      type: 'markdown',
      text: `The matrix shows ${shown.length} of ${summaries.length} libraries; the Libraries section lists all of them.`,
    })
  return {
    id: 'versions',
    title: 'Versions',
    description:
      'Lowest version each repository uses: the lockfile version where one was read, else the lowest the declared range admits.',
    blocks,
  }
}

function libraryCell(library: TrackedLibrary): Cell {
  const hints = [
    library.reason === 'auto' ? 'tracked automatically' : undefined,
    library.definedIn ? `defined in ${library.definedIn}` : undefined,
  ].filter(Boolean)
  return hints.length > 0 ? { text: library.name, hint: hints.join('; ') } : library.name
}

function librariesSection(
  summaries: LibrarySummary[],
  previous: LibrarySummary[] | undefined,
  compareTo?: string,
): Section {
  const before = new Map(previous?.map((summary) => [summary.id, summary]))
  const columns: Column[] = [
    { key: 'library', label: 'Library', format: 'code' },
    { key: 'ecosystem', label: 'Ecosystem' },
    { key: 'latest', label: 'Latest', unit: 'version' },
    { key: 'versions', label: 'Versions in use', format: 'tags' },
    { key: 'repos', label: 'Repositories', unit: 'count', align: 'end' },
    { key: 'oldest', label: 'On the oldest major', format: 'tags' },
    { key: 'behind', label: 'Behind a major', unit: 'count', align: 'end' },
    ...(previous
      ? [
          {
            key: 'delta',
            label: 'Δ behind',
            format: 'delta' as const,
            better: 'down' as const,
            align: 'end' as const,
          },
        ]
      : []),
  ]
  const rows = summaries.map((summary) => {
    const old = before.get(summary.id)
    return {
      library: libraryCell(summary.library),
      ecosystem: summary.library.ecosystem,
      latest: summary.library.latest ?? null,
      versions: summary.versions.join(', '),
      repos: summary.cells.size,
      oldest:
        summary.majors.length > 1
          ? {
              text: summary.reposOnOldest.join(', '),
              tone: 'warning' as const,
              hint: `major ${summary.majors[0]}`,
            }
          : '',
      behind: summary.reposBehindMajor.length,
      ...(previous
        ? { delta: old ? summary.reposBehindMajor.length - old.reposBehindMajor.length : null }
        : {}),
    }
  })
  const blocks: Block[] = [
    rows.length
      ? { type: 'table', columns, rows }
      : { type: 'markdown', text: 'No libraries are tracked.' },
  ]
  if (previous) {
    const now = new Map(summaries.map((summary) => [summary.id, summary]))
    const items: Issue[] = [
      ...summaries
        .filter(
          (summary) =>
            summary.majors.length > 1 && (before.get(summary.id)?.majors.length ?? 0) <= 1,
        )
        .map((summary) => ({
          id: `multi:${summary.id}`,
          tone: 'warning' as const,
          title: `${summary.library.name} is now used in ${summary.majors.length} majors`,
          detail: `Majors in use: ${summary.majors.join(', ')}`,
          tags: ['new'],
        })),
      ...(previous ?? [])
        .filter((old) => old.majors.length > 1 && (now.get(old.id)?.majors.length ?? 0) <= 1)
        .map((old) => ({
          id: `single:${old.id}`,
          tone: 'good' as const,
          title: `${old.library.name} is down to one major`,
          tags: ['resolved'],
        })),
    ]
    blocks.push(
      items.length
        ? { type: 'issues', title: `Since ${compareTo ?? 'the previous analysis'}`, items }
        : {
            type: 'markdown',
            text: `No library gained or lost a major version since ${compareTo ?? 'the previous analysis'}.`,
          },
    )
  }
  return {
    id: 'libraries',
    title: 'Libraries',
    description: 'Tracked libraries: listed in options, or used directly by enough repositories.',
    blocks,
  }
}

const resultKey = (result: TemplateResult) => `${result.repo}\0${result.file}`
const failing = (result: TemplateResult) =>
  result.status === 'drifted' || result.status === 'missing'

function configSection(
  data: FleetData,
  previous: FleetData | undefined,
  compareTo?: string,
): Section {
  if (data.templates.length === 0)
    return {
      id: 'config',
      title: 'Config drift',
      blocks: [{ type: 'markdown', text: 'No templates are configured.' }],
    }
  const files = [...new Set(data.templates.map((result) => result.file))]
  const byRepo = Map.groupBy(data.templates, (result) => result.repo)
  const columns: Column[] = [
    { key: 'repo', label: 'Repository', format: 'code' },
    ...files.map((file, index) => ({ key: `t${index}`, label: file })),
  ]
  const rows = [...byRepo].map(([repo, results]) => {
    const row: Record<string, Cell> = { repo }
    files.forEach((file, index) => {
      const result = results.find((entry) => entry.file === file)
      row[`t${index}`] = result
        ? {
            text: result.status,
            tone: statusTones[result.status],
            ...(result.problems.length ? { hint: result.problems.join('\n') } : {}),
          }
        : null
    })
    return row
  })

  const wasFailing = new Set(previous?.templates.filter(failing).map(resultKey))
  const issues: Issue[] = data.templates
    .filter((result) => result.status !== 'identical')
    .map((result) => ({
      id: resultKey(result),
      tone: statusTones[result.status],
      title: `${result.repo}: ${result.file} ${result.status}`,
      ...(result.problems.length ? { detail: result.problems.join('\n') } : {}),
      tags: [
        result.mode,
        ...(previous && failing(result) && !wasFailing.has(resultKey(result)) ? ['new'] : []),
      ],
    }))
  const isFailing = new Set(data.templates.filter(failing).map(resultKey))
  const resolved = (previous?.templates ?? []).filter(
    (result) => failing(result) && !isFailing.has(resultKey(result)),
  )
  issues.push(
    ...resolved.map((result) => ({
      id: `resolved:${resultKey(result)}`,
      tone: 'good' as const,
      title: `${result.repo}: ${result.file} matches the template again`,
      tags: [result.mode, 'resolved'],
    })),
  )
  const items = data.templates.flatMap((result) =>
    result.change
      ? [
          {
            change: result.change,
            diff: changeDiff(result.change),
            tone: statusTones[result.status],
            tags: [result.repo, result.file],
          },
        ]
      : [],
  )
  const blocks: Block[] = [{ type: 'table', title: 'Status per repository', columns, rows }]
  blocks.push(
    issues.length
      ? { type: 'issues', title: 'Differences', items: issues }
      : { type: 'markdown', text: 'Every repository matches every template.' },
  )
  if (items.length)
    blocks.push({ type: 'changes', title: 'Suggested fixes', items, applicable: true })
  return {
    id: 'config',
    title: 'Config drift',
    description: `Files compared with golden templates. Accepting fixes opens one merge request per repository.${previous ? ` New and resolved differences are against ${compareTo ?? 'the previous analysis'}.` : ''}`,
    blocks,
  }
}

function notesSection(data: FleetData): Section | undefined {
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
    ...data.libraries
      .filter((library) => !library.latest)
      .map((library) => ({
        id: `latest:${library.ecosystem}:${library.name}`,
        tone: 'info' as const,
        title: `Latest version of ${library.name} is unknown`,
        detail: 'The registry did not answer; lag is not shown for this library.',
      })),
  ]
  return items.length
    ? { id: 'notes', title: 'Notes', blocks: [{ type: 'issues', items }] }
    : undefined
}

/** The `fleet` analysis: library versions and config drift across the repositories of one group. */
export const fleetAnalysis = defineAnalysis<FleetData>({
  kind: 'fleet',
  label: 'Fleet drift',
  schema: fleetDataSchema,
  summarize: (data) => metricsOf(data),
  toReport(current, previous): Report {
    const data = current.data
    const before = previous?.data
    const compareTo = previous ? (previous.ref ?? previous.createdAt.slice(0, 10)) : undefined
    const summaries = data.libraries.map(summarizeLibrary)
    const notes = notesSection(data)
    return {
      kind: 'fleet',
      title: `Fleet drift: ${data.group}`,
      subtitle: `${plural(readableRepos(data).length, 'repository', 'repositories')}, ${plural(data.libraries.length, 'tracked library', 'tracked libraries')}`,
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(compareTo ? { compareTo } : {}),
      },
      generatedAt: current.createdAt,
      metrics: metricsOf(data, before),
      sections: [
        versionsSection(data, summaries),
        librariesSection(summaries, before?.libraries.map(summarizeLibrary), compareTo),
        configSection(data, before, compareTo),
        ...(notes ? [notes] : []),
      ],
    }
  },
  changes: (data) => data.templates.flatMap((result) => (result.change ? [result.change] : [])),
})
