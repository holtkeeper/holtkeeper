import { type RepoAssetsView, formatBytes } from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'

type Policy = RepoAssetsView['policy']
type Row = NonNullable<RepoAssetsView['summary']>['rows'][number]

/** Display order and series color of each asset kind, so a kind keeps its color everywhere. */
const kindOrder: readonly string[] = [
  'image',
  'audio',
  'video',
  'font',
  'atlas',
  'model',
  'data',
  'other',
]

/** Stable categorical color of an asset kind. */
export const kindColor = (kind: string): string => {
  const slot = kindOrder.indexOf(kind)
  return slot < 0 ? 'var(--series-8)' : `var(--series-${slot + 1})`
}

/** Tone of a row or problem severity: errors bad, warnings warn, the rest neutral. */
export const severityTone = (severity: Row['severity']): StatusTone =>
  severity === 'error' ? 'danger' : severity === 'warning' ? 'warning' : 'default'

/** Where the effective policy comes from, as shown next to it. */
export function policySource(source: RepoAssetsView['policySource']): string {
  if (source.level === 'default')
    return 'Default policy: nothing set for this repository or its groups'
  if (source.level === 'all') return 'Inherited from the entry for every repository'
  if (source.level === 'repo') return 'Set for this repository'
  const groups = source.entry?.scope.groups
  return groups?.length ? `Inherited from group ${groups.join(', ')}` : 'Inherited from a group'
}

const formatsLabel = (formats: readonly string[]) =>
  formats.map((format) => format.toUpperCase()).join(' and ')

/** The effective policy as short labelled lines, the same facts agents read. */
export function policyLines(policy: Policy): { label: string; value: string }[] {
  const required =
    policy.formats.raster === 'keep'
      ? []
      : policy.formats.raster === 'avif+webp'
        ? ['avif', 'webp']
        : [policy.formats.raster]
  const perKind = Object.entries(policy.maxBytes.perKind ?? {}).flatMap(([kind, limits]) =>
    limits
      ? [
          `${kind}: ${[limits.warn && `warn ${formatBytes(limits.warn)}`, limits.error && `error ${formatBytes(limits.error)}`].filter(Boolean).join(', ')}`,
        ]
      : [],
  )
  const budgets = [
    policy.budgets.total ? `all ${formatBytes(policy.budgets.total)}` : '',
    ...Object.entries(policy.budgets.perKind ?? {}).map(
      ([kind, max]) => `${kind} ${formatBytes(max)}`,
    ),
  ].filter(Boolean)
  return [
    {
      label: 'Rasters',
      value: required.length
        ? `${formatsLabel(required)} next to PNG, JPEG and GIF from 8 kB`
        : 'keep their formats',
    },
    { label: 'SVG', value: policy.formats.svg === 'optimize' ? 'optimized with svgo' : 'kept' },
    ...(policy.formats.allowed?.length
      ? [{ label: 'Allowed', value: policy.formats.allowed.join(', ') }]
      : []),
    {
      label: 'File size',
      value: `warn ${formatBytes(policy.maxBytes.warn)}, error ${formatBytes(policy.maxBytes.error)}${perKind.length ? `; ${perKind.join('; ')}` : ''}`,
    },
    { label: 'Dimensions', value: `at most ${policy.maxDimension} px` },
    {
      label: 'Min saving',
      value: `${policy.minSaving.pct}% and ${formatBytes(policy.minSaving.bytes)}`,
    },
    ...(budgets.length ? [{ label: 'Budgets', value: budgets.join(', ') }] : []),
    { label: 'Ignored', value: policy.ignore.length ? policy.ignore.join(', ') : 'nothing' },
    {
      label: 'Reviews',
      value: policy.mode === 'suggest-mr' ? 'comment and offer a merge request' : 'comment',
    },
  ]
}

const optimizable = new Set(['png', 'apng', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/** Whether the media dialog can make variants of a row's file. */
export const canOptimize = (row: Pick<Row, 'kind' | 'format'>): boolean =>
  row.kind === 'image' && optimizable.has(row.format.toLowerCase())

/** Rows narrowed to a severity filter: `issues` keeps errors and warnings. */
export function filterRows(rows: readonly Row[], filter: 'issues' | 'all'): Row[] {
  return filter === 'all' ? [...rows] : rows.filter((row) => row.severity !== 'info')
}
