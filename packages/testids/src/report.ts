import { defineAnalysis, metric } from '@holtkeeper/report'
import type {
  Block,
  Cell,
  Issue,
  Metric,
  Report,
  Section,
  Tone,
  TreeNode,
} from '@holtkeeper/report'

import {
  type TestIdFile,
  type TestIdsData,
  taggedPercent,
  testIdsDataSchema,
  testIdTotals,
} from './model.ts'

const limits = { files: 50, issues: 300, depth: 3, changes: 50 }

/** Share of elements with a test id from which a folder reads as good, and below which as bad. */
const thresholds = { good: 90, bad: 50 }

function tone(percent: number | undefined): Tone {
  if (percent === undefined) return 'neutral'
  if (percent >= thresholds.good) return 'good'
  return percent >= thresholds.bad ? 'warning' : 'bad'
}

function metrics(data: TestIdsData, previous?: TestIdsData): Metric[] {
  const now = testIdTotals(data.files)
  const before = previous ? testIdTotals(previous.files) : undefined
  const share = taggedPercent(now)
  const previousShare = before ? taggedPercent(before) : undefined
  return [
    ...(share === undefined
      ? []
      : [
          {
            ...metric('tagged', 'With test id', share, {
              unit: 'percent',
              previous: previousShare,
              better: 'up',
              hint: `Interactive elements with ${data.attributes.slice(0, 3).join(', ')} or another configured attribute`,
            }),
            tone: tone(share),
          },
        ]),
    metric('elements', 'Interactive elements', now.total, { previous: before?.total }),
    {
      ...metric('missing', 'Missing test ids', now.missing, {
        previous: before?.missing,
        better: 'down',
      }),
      ...(now.missing > 0 ? { tone: 'warning' as const } : { tone: 'good' as const }),
    },
    metric('unverified', 'Unverified', now.unverified, {
      previous: before?.unverified,
      better: 'down',
      hint: 'Spread props that may carry a test id at runtime',
    }),
  ]
}

interface Folder {
  total: number
  tagged: number
  children: Map<string, Folder>
}

function tree(files: readonly TestIdFile[]): TreeNode {
  const root: Folder = { total: 0, tagged: 0, children: new Map() }
  for (const file of files) {
    const parts = file.file.split('/')
    root.total += file.total
    root.tagged += file.tagged
    let node = root
    for (const part of parts.slice(0, Math.min(parts.length, limits.depth))) {
      let child = node.children.get(part)
      if (!child) {
        child = { total: 0, tagged: 0, children: new Map() }
        node.children.set(part, child)
      }
      child.total += file.total
      child.tagged += file.tagged
      node = child
    }
  }
  const toNode = (name: string, folder: Folder): TreeNode =>
    folder.children.size
      ? {
          name,
          tone: tone(taggedPercent(folder)),
          children: [...folder.children].map(([n, f]) => toNode(n, f)),
        }
      : { name, value: folder.total, tone: tone(taggedPercent(folder)) }
  return toNode('project', root)
}

const missingOf = (file: TestIdFile) => file.total - file.tagged - file.unverified

function overviewSection(data: TestIdsData): Section {
  const used = Object.entries(data.usage)
    .filter(([, count]) => count > 0)
    .toSorted((a, b) => b[1] - a[1])
  const blocks: Block[] = data.files.length
    ? [{ type: 'treemap', title: 'Interactive elements', unit: 'count', root: tree(data.files) }]
    : [{ type: 'markdown', text: 'No interactive elements were found in templates.' }]
  if (used.length > 1)
    blocks.push(
      {
        type: 'chart',
        title: 'Test id attributes in use',
        chart: 'donut',
        unit: 'count',
        x: 'attribute',
        series: [{ key: 'elements', label: 'Elements' }],
        data: used.map(([attribute, elements]) => ({ attribute, elements })),
      },
      {
        type: 'markdown',
        text: `${used.length} different test id attributes are in use; tests are easier to write against one.`,
      },
    )
  return {
    id: 'overview',
    title: 'By folder',
    description: `Size is interactive elements; green from ${thresholds.good}% with a test id, red below ${thresholds.bad}%.`,
    blocks,
  }
}

function filesSection(data: TestIdsData): Section {
  const ranked = data.files
    .filter((file) => file.tagged < file.total)
    .toSorted((a, b) => missingOf(b) - missingOf(a) || a.file.localeCompare(b.file))
  const rows: Record<string, Cell>[] = ranked.slice(0, limits.files).map((file) => {
    const share = taggedPercent(file) ?? 0
    return {
      file: file.file,
      source: file.source,
      elements: file.total,
      missing: missingOf(file),
      unverified: file.unverified,
      tagged: { text: `${share.toFixed(0)}%`, value: share, tone: tone(share) },
    }
  })
  return {
    id: 'files',
    title: 'Files with untagged elements',
    blocks: rows.length
      ? [
          {
            type: 'table',
            columns: [
              { key: 'file', label: 'File', format: 'code' },
              { key: 'source', label: 'Template' },
              { key: 'elements', label: 'Elements', unit: 'count', align: 'end' },
              { key: 'missing', label: 'Missing', unit: 'count', align: 'end' },
              { key: 'unverified', label: 'Unverified', unit: 'count', align: 'end' },
              { key: 'tagged', label: 'With test id', align: 'end' },
            ],
            rows,
          },
          ...(ranked.length > limits.files
            ? [
                {
                  type: 'markdown' as const,
                  text: `…and ${ranked.length - limits.files} more files.`,
                },
              ]
            : []),
        ]
      : [{ type: 'markdown', text: 'Every interactive element has a test id.' }],
  }
}

function elementsSection(data: TestIdsData): Section {
  const issues: Issue[] = data.files.flatMap((file) =>
    file.elements.map((element) => ({
      id: `testid-${file.file}:${element.line}:${element.tag}`,
      tone: element.status === 'missing' ? ('warning' as const) : ('neutral' as const),
      title: `${file.file}:${element.line} <${element.tag}>${element.as ? ` → ${element.as}` : ''}`,
      detail:
        element.status === 'missing'
          ? `Interactive (${element.reason}) without a test id.`
          : `Interactive (${element.reason}); spreads props, so a test id may come from its caller.`,
      tags: [element.status, file.source],
    })),
  )
  const missingFirst = issues.toSorted(
    (a, b) => Number(a.tone !== 'warning') - Number(b.tone !== 'warning'),
  )
  return {
    id: 'elements',
    title: 'Elements without a test id',
    blocks: issues.length
      ? [
          { type: 'issues', items: missingFirst.slice(0, limits.issues) },
          ...(issues.length > limits.issues
            ? [
                {
                  type: 'markdown' as const,
                  text: `…and ${issues.length - limits.issues} more elements.`,
                },
              ]
            : []),
        ]
      : [{ type: 'markdown', text: 'Every interactive element has a test id.' }],
  }
}

function changesSection(data: TestIdsData, previous: TestIdsData, compareTo?: string): Section {
  const before = new Map(previous.files.map((file) => [file.file, missingOf(file)]))
  const now = new Map(data.files.map((file) => [file.file, missingOf(file)]))
  const rows = [...new Set([...before.keys(), ...now.keys()])]
    .map((file) => ({
      file,
      before: before.get(file) ?? 0,
      after: now.get(file) ?? 0,
    }))
    .filter((row) => row.before !== row.after)
    .map((row) => ({ ...row, delta: row.after - row.before }))
    .toSorted((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.file.localeCompare(b.file))
  const since = compareTo ?? 'the previous analysis'
  return {
    id: 'changes',
    title: 'Changes',
    blocks: rows.length
      ? [
          {
            type: 'table',
            title: `Missing test ids since ${since}`,
            columns: [
              { key: 'file', label: 'File', format: 'code' },
              { key: 'before', label: 'Before', unit: 'count', align: 'end' },
              { key: 'after', label: 'After', unit: 'count', align: 'end' },
              { key: 'delta', label: 'Change', unit: 'count', format: 'delta', better: 'down' },
            ],
            rows: rows.slice(0, limits.changes),
          },
        ]
      : [{ type: 'markdown', text: `No file gained or lost test ids since ${since}.` }],
  }
}

/** Turns `TestIdsData` into a report. Exported for tests and for clients that render locally. */
export function testIdsReport(
  data: TestIdsData,
  options: { previous?: TestIdsData; ref?: string; compareTo?: string; generatedAt?: string } = {},
): Omit<Report, 'subject'> {
  const { previous, compareTo } = options
  return {
    kind: 'testids',
    title: 'Test ids',
    ...(options.ref ? { subtitle: options.ref } : {}),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    metrics: metrics(data, previous),
    sections: [
      overviewSection(data),
      filesSection(data),
      elementsSection(data),
      ...(previous ? [changesSection(data, previous, compareTo)] : []),
    ],
  }
}

/**
 * The `testids` analysis kind: interactive elements of a repository's templates and whether they
 * carry a test id attribute for end-to-end tests. `With test id` carries `better: 'up'`.
 */
export const testIdsAnalysis = defineAnalysis<TestIdsData>({
  kind: 'testids',
  label: 'Test ids',
  schema: testIdsDataSchema,
  summarize: (data) => metrics(data),
  toReport(current, previous) {
    return {
      ...testIdsReport(current.data, {
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
