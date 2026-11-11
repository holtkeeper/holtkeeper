import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Metric, Report, Section, Tone, TreeNode } from '@holtkeeper/report'

import {
  type Counts,
  type CoverageData,
  coverageDataSchema,
  type FileCoverageData,
  percentOf,
  sumCounts,
} from './model.ts'
import { coverageChanges } from './summary.ts'

const limits = { depth: 3, changes: 50 }

/** Line coverage from which a file or folder reads as good, and below which it reads as bad. */
const thresholds = { good: 80, bad: 50 }

/** Tone of a coverage share: good, warning in between, bad. */
export function coverageTone(percent: number | undefined): Tone {
  if (percent === undefined) return 'neutral'
  if (percent >= thresholds.good) return 'good'
  return percent >= thresholds.bad ? 'warning' : 'bad'
}

const untested = (data: CoverageData) => data.files.filter((file) => file.loaded === false).length

function metrics(data: CoverageData, previous?: CoverageData): Metric[] {
  const share = (
    id: string,
    label: string,
    pick: (summary: CoverageData['summary']) => Counts | undefined,
    hint: string,
  ): Metric[] => {
    const value = percentOf(pick(data.summary))
    if (value === undefined) return []
    return [
      {
        ...metric(id, label, value, {
          unit: 'percent',
          previous: previous ? percentOf(pick(previous.summary)) : undefined,
          better: 'up',
          hint,
        }),
        tone: coverageTone(value),
      },
    ]
  }
  return [
    ...share('lines', 'Line coverage', (s) => s.lines, 'Executable lines run by at least one test'),
    ...share('functions', 'Function coverage', (s) => s.functions, 'Functions called by tests'),
    ...share('branches', 'Branch coverage', (s) => s.branches, 'Branch outcomes taken by tests'),
    metric('files', 'Source files', data.files.length, { previous: previous?.files.length }),
    {
      ...metric('untested', 'Files without tests', untested(data), {
        previous: previous ? untested(previous) : undefined,
        better: 'down',
        hint: 'Source files no test loaded',
      }),
      ...(untested(data) > 0 ? { tone: 'warning' as const } : {}),
    },
  ]
}

interface Folder {
  lines: Counts[]
  children: Map<string, Folder>
}

/** Folders down to `limits.depth` levels, sized by lines to cover and colored by coverage. */
export function coverageTree(files: readonly FileCoverageData[]): TreeNode {
  const root: Folder = { lines: [], children: new Map() }
  for (const file of files) {
    const parts = file.file.split('/')
    root.lines.push(file.lines)
    let node = root
    for (const part of parts.slice(0, Math.min(parts.length, limits.depth))) {
      let child = node.children.get(part)
      if (!child) {
        child = { lines: [], children: new Map() }
        node.children.set(part, child)
      }
      child.lines.push(file.lines)
      node = child
    }
  }
  const toNode = (name: string, folder: Folder): TreeNode => {
    const lines = sumCounts(folder.lines) ?? { covered: 0, total: 0 }
    const tone = coverageTone(percentOf(lines))
    return folder.children.size
      ? { name, tone, children: [...folder.children].map(([n, f]) => toNode(n, f)) }
      : { name, value: lines.total, tone }
  }
  return toNode('project', root)
}

function overviewSection(data: CoverageData): Section {
  const covered = data.files.filter((file) => file.lines.total > 0)
  return {
    id: 'overview',
    title: 'By folder',
    description: `Measured with ${data.tools.join(', ') || 'unknown tools'}. Size is lines to cover; green from ${thresholds.good}%, red below ${thresholds.bad}%.`,
    blocks: covered.length
      ? [{ type: 'treemap', title: 'Lines to cover', unit: 'count', root: coverageTree(covered) }]
      : [{ type: 'markdown', text: 'No source files were measured.' }],
  }
}

function changesSection(data: CoverageData, previous: CoverageData, compareTo?: string): Section {
  const rows = coverageChanges(data, previous, 1)
    .slice(0, limits.changes)
    .map((change) => ({ ...change, before: change.before ?? null }))
  const since = compareTo ?? 'the previous analysis'
  return {
    id: 'changes',
    title: 'Changes',
    blocks: rows.length
      ? [
          {
            type: 'table',
            title: `Line coverage since ${since}`,
            columns: [
              { key: 'file', label: 'File', format: 'code' },
              { key: 'before', label: 'Before', unit: 'percent', align: 'end' },
              { key: 'after', label: 'After', unit: 'percent', align: 'end' },
              { key: 'delta', label: 'Change', unit: 'percent', format: 'delta', better: 'up' },
            ],
            rows,
          },
        ]
      : [{ type: 'markdown', text: `No file changed its coverage by 1% or more since ${since}.` }],
  }
}

/** Turns `CoverageData` into a report. Exported for tests and for clients that render locally. */
export function coverageReport(
  data: CoverageData,
  options: { previous?: CoverageData; ref?: string; compareTo?: string; generatedAt?: string } = {},
): Omit<Report, 'subject'> {
  const { previous, compareTo } = options
  return {
    kind: 'coverage',
    title: 'Test coverage',
    ...(options.ref ? { subtitle: options.ref } : {}),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    metrics: metrics(data, previous),
    sections: [
      overviewSection(data),
      ...(previous ? [changesSection(data, previous, compareTo)] : []),
    ],
  }
}

/**
 * The `coverage` analysis kind: line, function and branch coverage of a repository's source files
 * with the folders and files that lack tests. Coverage metrics carry `better: 'up'`.
 */
export const coverageAnalysis = defineAnalysis<CoverageData>({
  kind: 'coverage',
  label: 'Test coverage',
  schema: coverageDataSchema,
  summarize: (data) => metrics(data),
  toReport(current, previous) {
    return {
      ...coverageReport(current.data, {
        previous: previous?.data,
        ref: current.ref,
        compareTo: previous?.ref,
      }),
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(previous?.ref ? { compareTo: previous.ref } : {}),
      },
    }
  },
})
