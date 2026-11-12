import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Metric, MetricsContext, Report, Section, Tone, TreeNode } from '@holtkeeper/report'
import { z } from 'zod'

import {
  type Counts,
  type CoverageData,
  coverageDataSchema,
  type FileCoverageData,
  percentOf,
  sumCounts,
} from './model.ts'
import { type CoverageTotals, coverageChanges, coverageTotals } from './summary.ts'

const limits = { depth: 3, changes: 50 }

/** Line coverage from which a file or folder reads as good, and below which it reads as bad. */
const thresholds = { good: 80, bad: 50 }

/** Tone of a coverage share: good, warning in between, bad. */
export function coverageTone(percent: number | undefined): Tone {
  if (percent === undefined) return 'neutral'
  if (percent >= thresholds.good) return 'good'
  return percent >= thresholds.bad ? 'warning' : 'bad'
}

/** Line coverage a repository should reach when its `analyzers.coverage` options set no `target`. */
export const DEFAULT_COVERAGE_TARGET = 60

/**
 * The `target` option of the `coverage` analyzer: line coverage to reach, in percent, as a number
 * or numeric string from 0 to 100. Null and empty strings are rejected.
 */
export const coverageTargetSchema = z
  .union([z.number(), z.string().trim().min(1)])
  .pipe(z.coerce.number<string | number>().min(0).max(100))

/** Stored headline numbers of one `coverage` record. Shares are percent, 0..100. */
export interface CoverageMetrics {
  /** Line coverage over every file; absent when there is nothing to cover. */
  percent?: number
  functions?: number
  branches?: number
  /** `percent` minus the previous record's, in percentage points; absent without both. */
  delta?: number
  /** Line coverage the repository should reach (option `target`). */
  target: number
  files: number
  /** Source files no test loaded. */
  untested: number
  /** Tools that produced the record; absent for records written before. */
  tools?: string[]
  /** Covered and total counts, as `coverageTotals` gives them; absent for records written before. */
  totals?: CoverageTotals
}

const rounded = (value: number | undefined) =>
  value === undefined ? undefined : Math.round(value * 100) / 100

/** The coverage target `options` (the `coverage` analyzer's) set; 60 when unset or invalid. */
export function coverageTargetOf(options: unknown): number {
  const value =
    typeof options === 'object' && options !== null && 'target' in options
      ? options.target
      : undefined
  return coverageTargetSchema.safeParse(value).data ?? DEFAULT_COVERAGE_TARGET
}

/**
 * `CoverageMetrics` of `data`: shares rounded to 0.01, the target from `options.target` (60 when
 * unset or invalid) and the delta against `previous`.
 */
export function coverageMetrics(
  data: CoverageData,
  { options, previous }: MetricsContext<CoverageMetrics> = {},
): CoverageMetrics {
  const percent = rounded(percentOf(data.summary.lines))
  const functions = rounded(percentOf(data.summary.functions))
  const branches = rounded(percentOf(data.summary.branches))
  const target = coverageTargetOf(options)
  return {
    ...(percent === undefined ? {} : { percent }),
    ...(functions === undefined ? {} : { functions }),
    ...(branches === undefined ? {} : { branches }),
    ...(percent !== undefined && previous?.percent !== undefined
      ? { delta: Math.round((percent - previous.percent) * 100) / 100 }
      : {}),
    target,
    files: data.files.length,
    untested: untested(data),
    tools: data.tools,
    totals: coverageTotals(data),
  }
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
export const coverageAnalysis = defineAnalysis<CoverageData, CoverageMetrics>({
  kind: 'coverage',
  label: 'Test coverage',
  schema: coverageDataSchema,
  summarize: (data) => metrics(data),
  metrics: coverageMetrics,
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
