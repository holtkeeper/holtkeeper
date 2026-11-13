import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Block, Cell, Issue, Metric, Report, Section, Tone } from '@holtkeeper/report'

import { type PackageDiff, diffApi } from './diff.ts'
import {
  type ApiGoModule,
  type ApiSurfaceData,
  apiSurfaceDataSchema,
  apiTotals,
  documentedPercent,
} from './model.ts'
import { importPath } from './render.ts'

const limits = { packages: 200, changes: 300, undocumented: 30 }

/** Share of documented exports from which a package reads as good, and below which as bad. */
const thresholds = { good: 80, bad: 40 }

function tone(percent: number | undefined): Tone {
  if (percent === undefined) return 'neutral'
  if (percent >= thresholds.good) return 'good'
  return percent >= thresholds.bad ? 'warning' : 'bad'
}

function goMetrics(data: ApiSurfaceData): Metric[] {
  const modules = data.go?.modules
  if (!modules?.length) return []
  const sum = (pick: (module: ApiGoModule) => number) =>
    modules.reduce((total, module) => total + pick(module), 0)
  return [
    metric(
      'goImportable',
      'Go importable packages',
      sum((module) => module.packages),
      {
        hint: 'Go packages outside internal/ that other modules can import',
      },
    ),
    metric(
      'goInternal',
      'Go internal packages',
      sum((module) => module.internalPackages),
    ),
    metric(
      'goMain',
      'Go main packages',
      sum((module) => module.mainPackages),
      {
        hint: 'Commands (package main); never part of the public API',
      },
    ),
  ]
}

function metrics(data: ApiSurfaceData, previous?: ApiSurfaceData): Metric[] {
  const now = apiTotals(data.packages)
  const before = previous ? apiTotals(previous.packages) : undefined
  const share = documentedPercent(now)
  const diffs = previous ? diffApi(previous.packages, data.packages) : undefined
  const removed = diffs?.reduce((sum, diff) => sum + diff.removed, 0)
  return [
    metric('packages', 'Packages', now.packages, { previous: before?.packages }),
    metric('exports', 'Exports', now.symbols, { previous: before?.symbols }),
    ...(share === undefined
      ? []
      : [
          {
            ...metric('documented', 'Documented', share, {
              unit: 'percent',
              previous: before ? documentedPercent(before) : undefined,
              better: 'up',
              hint: 'Exports with a doc comment (TSDoc, JSDoc or Go doc)',
            }),
            tone: tone(share),
          },
        ]),
    metric('deprecated', 'Deprecated', now.deprecated, {
      previous: before?.deprecated,
      better: 'down',
    }),
    ...goMetrics(data),
    ...(removed === undefined
      ? []
      : [
          {
            ...metric('removed', 'Removed exports', removed, {
              better: 'down',
              hint: 'Exports gone since the previous analysis; callers using them break',
            }),
            tone: removed > 0 ? ('warning' as const) : ('good' as const),
          },
        ]),
  ]
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * One line on a checkout whose Go modules have no package other modules can import, e.g. a service
 * made of `cmd/` and `internal/`; `undefined` when there is no Go module or one is importable.
 */
export function goInternalOnly(data: ApiSurfaceData): string | undefined {
  const modules = data.go?.modules ?? []
  if (!modules.length || modules.some((module) => module.packages > 0)) return undefined
  const main = modules.reduce((sum, module) => sum + module.mainPackages, 0)
  const internal = modules.reduce((sum, module) => sum + module.internalPackages, 0)
  return `Internal only: ${plural(main, 'main package')}, ${plural(internal, 'internal package')}; no Go package here can be imported by other modules.`
}

function packagesSection(data: ApiSurfaceData): Section {
  const go = data.packages.some((pkg) => pkg.ecosystem === 'Go')
  const rows: Record<string, Cell>[] = data.packages.slice(0, limits.packages).map((pkg) => {
    const totals = apiTotals([pkg])
    const share = documentedPercent(totals)
    return {
      name: pkg.name,
      ...(go
        ? {
            ecosystem:
              pkg.ecosystem === 'Go'
                ? pkg.private
                  ? 'Go, internal'
                  : 'Go'
                : (pkg.ecosystem ?? 'npm'),
          }
        : {}),
      version: pkg.version ?? '',
      dir: pkg.dir,
      entries: pkg.entries.length,
      exports: totals.symbols,
      documented:
        share === undefined
          ? ''
          : { text: `${share.toFixed(0)}%`, value: share, tone: tone(share) },
      deprecated: totals.deprecated,
    }
  })
  const internalOnly = goInternalOnly(data)
  return {
    id: 'packages',
    title: 'Packages',
    description: `Green from ${thresholds.good}% of exports documented, red below ${thresholds.bad}%.`,
    blocks: [
      ...(internalOnly ? [{ type: 'markdown' as const, text: internalOnly }] : []),
      ...(rows.length
        ? [
            {
              type: 'table' as const,
              columns: [
                { key: 'name', label: 'Package', format: 'code' as const },
                ...(go ? [{ key: 'ecosystem', label: 'Ecosystem' }] : []),
                { key: 'version', label: 'Version' },
                { key: 'dir', label: 'Folder', format: 'code' as const },
                {
                  key: 'entries',
                  label: 'Entry points',
                  unit: 'count' as const,
                  align: 'end' as const,
                },
                { key: 'exports', label: 'Exports', unit: 'count' as const, align: 'end' as const },
                { key: 'documented', label: 'Documented', align: 'end' as const },
                {
                  key: 'deprecated',
                  label: 'Deprecated',
                  unit: 'count' as const,
                  align: 'end' as const,
                },
              ],
              rows,
            },
          ]
        : internalOnly
          ? []
          : [
              {
                type: 'markdown' as const,
                text: 'No npm package with a resolvable entry point and no Go package was found.',
              },
            ]),
    ],
  }
}

function goModulesSection(data: ApiSurfaceData): Section | undefined {
  const modules = data.go?.modules ?? []
  if (!modules.length) return undefined
  return {
    id: 'go-modules',
    title: 'Go modules',
    description:
      'Importable packages are the ones outside internal/ that are not package main; versions come from module tags on the analyzed commit.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'path', label: 'Module', format: 'code' },
          { key: 'version', label: 'Version' },
          { key: 'dir', label: 'Folder', format: 'code' },
          { key: 'packages', label: 'Importable', unit: 'count', align: 'end' },
          { key: 'internal', label: 'Internal', unit: 'count', align: 'end' },
          { key: 'main', label: 'Main', unit: 'count', align: 'end' },
        ],
        rows: modules.map((module) => ({
          path: module.path,
          version: module.version ?? '',
          dir: module.dir,
          packages: module.packages,
          internal: module.internalPackages,
          main: module.mainPackages,
        })),
      },
    ],
  }
}

function undocumentedSection(data: ApiSurfaceData): Section | undefined {
  const items: Issue[] = data.packages.flatMap((pkg) =>
    pkg.entries.flatMap((entry) =>
      entry.symbols
        .filter((symbol) => !symbol.doc && symbol.kind !== 'reexport')
        .map((symbol) => ({
          id: `undocumented-${pkg.name}-${entry.subpath}-${symbol.name}`,
          tone: 'neutral' as const,
          title: `${importPath(pkg.name, entry.subpath)} → ${symbol.name}`,
          detail: `${symbol.kind} at ${symbol.file}:${symbol.line} has no doc comment.`,
          tags: [symbol.kind],
        })),
    ),
  )
  if (!items.length) return undefined
  return {
    id: 'undocumented',
    title: 'Undocumented exports',
    blocks: [
      { type: 'issues', items: items.slice(0, limits.undocumented) },
      ...(items.length > limits.undocumented
        ? [{ type: 'markdown' as const, text: `…and ${items.length - limits.undocumented} more.` }]
        : []),
    ],
  }
}

const changeTone = {
  removed: 'bad',
  changed: 'warning',
  deprecated: 'warning',
  added: 'good',
} as const

function changesSection(diffs: PackageDiff[], compareTo?: string): Section {
  const since = compareTo ?? 'the previous analysis'
  if (!diffs.length)
    return {
      id: 'changes',
      title: 'Changes',
      blocks: [
        { type: 'markdown', text: `No export was added, removed or changed since ${since}.` },
      ],
    }
  const rows: Record<string, Cell>[] = diffs.map((diff) => ({
    name: diff.name,
    versions: `${diff.from ?? 'new'} → ${diff.to ?? 'removed'}`,
    removed: diff.removed,
    changed: diff.changed,
    added: diff.added,
    required: {
      text: diff.required,
      tone: diff.semverWarning ? 'bad' : diff.required === 'major' ? 'warning' : 'neutral',
    },
  }))
  const issues: Issue[] = diffs.flatMap((diff) => [
    ...(diff.semverWarning
      ? [
          {
            id: `semver-${diff.name}`,
            tone: 'bad' as const,
            title: `${diff.name}: semver`,
            detail: diff.semverWarning,
            tags: ['semver'],
          },
        ]
      : []),
    ...diff.changes.map((change) => ({
      id: `${change.change}-${diff.name}-${change.subpath}-${change.name}`,
      tone: changeTone[change.change],
      title: `${change.change}: ${importPath(diff.name, change.subpath)} → ${change.name}`,
      detail: [
        change.before && `Before: ${change.before}`,
        change.after && `After: ${change.after}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      tags: [change.change, change.kind],
    })),
  ])
  const blocks: Block[] = [
    {
      type: 'table',
      title: `Exports since ${since}`,
      columns: [
        { key: 'name', label: 'Package', format: 'code' },
        { key: 'versions', label: 'Versions' },
        { key: 'removed', label: 'Removed', unit: 'count', align: 'end' },
        { key: 'changed', label: 'Changed', unit: 'count', align: 'end' },
        { key: 'added', label: 'Added', unit: 'count', align: 'end' },
        { key: 'required', label: 'Calls for', align: 'end' },
      ],
      rows,
    },
    { type: 'issues', items: issues.slice(0, limits.changes) },
    ...(issues.length > limits.changes
      ? [
          {
            type: 'markdown' as const,
            text: `…and ${issues.length - limits.changes} more changes.`,
          },
        ]
      : []),
  ]
  return { id: 'changes', title: 'Changes', blocks }
}

function problemsSection(data: ApiSurfaceData): Section | undefined {
  const problems = data.packages.flatMap((pkg) =>
    (pkg.problems ?? []).map((p) => `${pkg.name}: ${p}`),
  )
  if (!problems.length) return undefined
  return {
    id: 'problems',
    title: 'Unreadable files',
    blocks: [{ type: 'markdown', text: problems.map((p) => `- \`${p}\``).join('\n') }],
  }
}

/** Turns `ApiSurfaceData` into a report. Exported for tests and for clients that render locally. */
export function apiSurfaceReport(
  data: ApiSurfaceData,
  options: {
    previous?: ApiSurfaceData
    ref?: string
    compareTo?: string
    generatedAt?: string
  } = {},
): Omit<Report, 'subject'> {
  const { previous, compareTo } = options
  return {
    kind: 'api-surface',
    title: 'Public API',
    ...(options.ref ? { subtitle: options.ref } : {}),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    metrics: metrics(data, previous),
    sections: [
      packagesSection(data),
      ...(previous ? [changesSection(diffApi(previous.packages, data.packages), compareTo)] : []),
      ...[goModulesSection(data), undocumentedSection(data), problemsSection(data)].filter(
        (section): section is Section => section !== undefined,
      ),
    ],
  }
}

/**
 * The `api-surface` analysis kind: the exported API of every package in a repository with doc
 * comments, and what changed since the previous record. `Documented` carries `better: 'up'`.
 */
export const apiSurfaceAnalysis = defineAnalysis<ApiSurfaceData>({
  kind: 'api-surface',
  label: 'Public API',
  schema: apiSurfaceDataSchema,
  summarize: (data) => metrics(data),
  toReport(current, previous) {
    return {
      ...apiSurfaceReport(current.data, {
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
