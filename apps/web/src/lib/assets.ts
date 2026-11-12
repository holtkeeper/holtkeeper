import {
  type AssetsOverview,
  type AssetsOverviewRow,
  type AssetsPolicySource,
  type AssetsQuery,
  type AssetsRepoSummary,
  type AssetsSort,
  type AssetsStatusFilter,
  type RepoAssetsView,
  type SettingList,
  formatBytes,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { repoKey } from './repo.ts'
import { searchEntry, searchEnum, searchText } from './search-params.ts'

type Policy = RepoAssetsView['policy']
type AssetKind = NonNullable<AssetsQuery['kind']>
type Problem = AssetsOverviewRow['problems'][number]

/** Every asset kind in display order, so a kind keeps its place and color everywhere. */
export const assetKinds: readonly AssetKind[] = [
  'image',
  'audio',
  'video',
  'font',
  'atlas',
  'model',
  'data',
  'other',
]

const problemRules: readonly Problem['rule'][] = [
  'format',
  'max-bytes',
  'max-dimension',
  'modern-format',
  'budget',
  'duplicate',
  'saving',
]

/** Stable categorical color of an asset kind. */
export const kindColor = (kind: string): string => {
  const slot = assetKinds.findIndex((known) => known === kind)
  return slot < 0 ? 'var(--series-8)' : `var(--series-${slot + 1})`
}

/** Plural label of a kind for legends: "Images", "Fonts", "Video". */
export const kindLabel = (kind: string): string =>
  ({ image: 'Images', font: 'Fonts', model: 'Models', atlas: 'Atlases' })[kind] ??
  kind.charAt(0).toUpperCase() + kind.slice(1)

/** Tone of a row or problem severity: errors bad, warnings warn, the rest neutral. */
export const severityTone = (severity: Problem['severity']): StatusTone =>
  severity === 'error' ? 'danger' : severity === 'warning' ? 'warning' : 'default'

const ruleLabels: Record<Problem['rule'], string> = {
  format: 'format not allowed',
  'max-bytes': 'over the size limit',
  'max-dimension': 'over the dimension limit',
  'modern-format': 'no modern format',
  budget: 'budget',
  duplicate: 'duplicate',
  saving: 'saving',
}

/** Short tag text of a problem: "Error · over the size limit", "Duplicate". */
export function problemLabel(problem: Pick<Problem, 'rule' | 'severity'>): string {
  if (problem.severity === 'info') {
    const rule = ruleLabels[problem.rule]
    return rule.charAt(0).toUpperCase() + rule.slice(1)
  }
  return `${problem.severity === 'error' ? 'Error' : 'Warning'} · ${ruleLabels[problem.rule]}`
}

/** "image · 2400×1600" under a file path. */
export const rowMeta = (row: Pick<AssetsOverviewRow, 'kind' | 'width' | 'height'>): string =>
  row.width && row.height ? `${row.kind} · ${row.width}×${row.height}` : row.kind

/** Percent of a row's bytes its suggestion saves, 0 to 100. */
export const savingPercent = (row: Pick<AssetsOverviewRow, 'bytes' | 'suggestion'>): number =>
  row.suggestion && row.bytes > 0
    ? Math.min(100, Math.round((row.suggestion.saving / row.bytes) * 100))
    : 0

/** Where the effective policy comes from, as shown next to it. */
export function policySource(source: AssetsPolicySource): string {
  if (source.level === 'default')
    return 'Default policy: nothing set for this repository or its groups'
  if (source.level === 'all') return 'Inherited from the entry for every repository'
  if (source.level === 'repo') return 'Set for this repository'
  const groups = source.entry?.scope.groups?.flat()
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
      label: 'In reviews',
      value: policy.mode === 'suggest-mr' ? 'comment and offer a merge request' : 'comment',
    },
  ]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nested = ['formats', 'maxBytes', 'minSaving', 'budgets'] as const

const isPolicy = (value: unknown): value is Policy =>
  isRecord(value) &&
  isRecord(value.formats) &&
  typeof value.formats.raster === 'string' &&
  typeof value.formats.svg === 'string' &&
  isRecord(value.maxBytes) &&
  typeof value.maxBytes.warn === 'number' &&
  typeof value.maxBytes.error === 'number' &&
  typeof value.maxDimension === 'number' &&
  isRecord(value.minSaving) &&
  typeof value.minSaving.pct === 'number' &&
  typeof value.minSaving.bytes === 'number' &&
  Array.isArray(value.ignore) &&
  isRecord(value.budgets) &&
  typeof value.mode === 'string'

/**
 * A stored `assets.policy` value with every missing field taken from `defaults`; `defaults` when
 * the value does not read as a policy.
 */
export function withPolicyDefaults(value: unknown, defaults: Policy): Policy {
  if (!isRecord(value)) return defaults
  const merged: Record<string, unknown> = { ...defaults, ...value }
  for (const key of nested) {
    const own = value[key]
    merged[key] = isRecord(own) ? { ...defaults[key], ...own } : defaults[key]
  }
  return isPolicy(merged) ? merged : defaults
}

/** The policy every repository starts from, where it comes from and how many entries narrow it. */
export interface FleetPolicy {
  policy: Policy
  source: string
  /** `assets.policy` entries scoped to groups or repositories, which replace it there. */
  overrides: number
}

/**
 * The fleet's asset policy from the settings list: the entry for every repository, else the
 * setting's default. `undefined` when the list does not define `assets.policy`.
 */
export function fleetPolicy(list: SettingList): FleetPolicy | undefined {
  const definition = list.definitions.find((d) => d.key === 'assets.policy')
  const defaults = definition?.default
  if (!isPolicy(defaults)) return undefined
  const entries = list.settings.filter((entry) => entry.key === 'assets.policy')
  const all = entries.find((entry) => entry.scope.all)
  return {
    policy: all ? withPolicyDefaults(all.value, defaults) : defaults,
    source: all ? 'Set for every repository' : 'Default policy: nothing set for every repository',
    overrides: entries.filter((entry) => !entry.scope.all).length,
  }
}

/** "2 groups or repositories override it", or nothing without overrides. */
export const overridesText = (count: number): string =>
  count === 0
    ? ''
    : `${count} ${count === 1 ? 'group or repository overrides' : 'groups or repositories override'} it`

const optimizable = new Set(['png', 'apng', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/** Whether the media optimizer can make variants of a row's file. */
export const canOptimize = (row: Pick<AssetsOverviewRow, 'kind' | 'format'>): boolean =>
  row.kind === 'image' && optimizable.has(row.format.toLowerCase())

/** A file row of the Assets table with its repository's groups, for the scope switch. */
export interface AssetTableRow extends AssetsOverviewRow {
  key: string
  groups: readonly string[]
}

/** Unique key of a file row: `forge:path` and the file path. */
export const assetRowKey = (row: Pick<AssetsOverviewRow, 'repo' | 'path'>): string =>
  `${repoKey(row.repo)}|${row.path}`

/** Loaded pages as table rows, each with its repository's groups; repeated rows are dropped. */
export function assetTableRows(pages: readonly AssetsOverview[]): AssetTableRow[] {
  const groups = new Map<string, readonly string[]>()
  for (const page of pages)
    for (const repo of page.repos) groups.set(repoKey(repo.repo), repo.groups)
  const seen = new Set<string>()
  const rows: AssetTableRow[] = []
  for (const page of pages)
    for (const item of page.items) {
      const key = assetRowKey(item)
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ ...item, key, groups: groups.get(repoKey(item.repo)) ?? [] })
    }
  return rows
}

/** Rows whose repository, path or format contains every word of `query`, ignoring case. */
export function searchAssetRows<T extends Pick<AssetsOverviewRow, 'repo' | 'path' | 'format'>>(
  rows: readonly T[],
  query: string | undefined,
): T[] {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...rows]
  return rows.filter((row) => {
    const text = `${repoKey(row.repo)} ${row.path} ${row.format}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

/** Headline figures over some repositories' newest assets records. */
export interface AssetsKpis {
  repos: number
  files: number
  bytes: number
  savings: number
  errors: number
  warnings: number
  duplicateBytes: number
  budgets: number
  /** Repositories with an exceeded budget. */
  overBudget: AssetsRepoSummary['repo'][]
  /** Percent change of `bytes` against the previous records; absent when no repository has one. */
  trend?: number
  /** Bytes per kind in display order; only kinds with bytes. */
  kinds: { kind: AssetKind; bytes: number }[]
}

/** Sums `repos` into the figures of the Assets strip and kind bar. */
export function assetsKpis(repos: readonly AssetsRepoSummary[]): AssetsKpis {
  const sum = (pick: (repo: AssetsRepoSummary) => number) =>
    repos.reduce((total, repo) => total + pick(repo), 0)
  const bytes = sum((repo) => repo.bytes)
  const withDelta = repos.filter((repo) => repo.delta !== undefined)
  const delta = withDelta.reduce((total, repo) => total + (repo.delta ?? 0), 0)
  const before = withDelta.reduce((total, repo) => total + repo.bytes - (repo.delta ?? 0), 0)
  return {
    repos: repos.length,
    files: sum((repo) => repo.files),
    bytes,
    savings: sum((repo) => repo.savings),
    errors: sum((repo) => repo.errors),
    warnings: sum((repo) => repo.warnings),
    duplicateBytes: sum((repo) => repo.duplicateBytes),
    budgets: sum((repo) => repo.budgets),
    overBudget: repos.filter((repo) => repo.budgets > 0).map((repo) => repo.repo),
    ...(withDelta.length && before > 0 ? { trend: (delta / before) * 100 } : {}),
    kinds: assetKinds
      .map((kind) => ({ kind, bytes: sum((repo) => repo.kinds[kind] ?? 0) }))
      .filter((entry) => entry.bytes > 0),
  }
}

/** "↑ 6%", "↓ 2%" or "no change" for a percent change. */
export function trendText(percent: number): string {
  const rounded = Math.round(percent)
  if (rounded === 0) return 'no change'
  return rounded > 0 ? `↑ ${rounded}%` : `↓ ${-rounded}%`
}

/**
 * The one id a single-choice `FilterButton` keeps after a change: the newly picked id, or none
 * when the current one was unpicked.
 */
export const singleChoice = (next: readonly string[], current: string | undefined) =>
  next.find((id) => id !== current) ?? (current && next.includes(current) ? current : undefined)

const statuses: readonly AssetsStatusFilter[] = ['policy', 'saving', 'any']
const sorts: readonly AssetsSort[] = ['severity', 'saving', 'size']

/**
 * Search parameters of Quality › Assets; omitted keys are the defaults (`status` policy, `sort`
 * severity).
 */
export interface AssetsSearch {
  /** `forge:path` the page narrows to. */
  repo?: string
  group?: string
  status?: Exclude<AssetsStatusFilter, 'policy'>
  kind?: AssetKind
  format?: string
  problem?: Problem['rule']
  sort?: Exclude<AssetsSort, 'severity'>
  q?: string
}

/** `AssetsSearch` from raw search values; unknown, empty and default values are dropped. */
export function parseAssetsSearch(search: Record<string, unknown>): AssetsSearch {
  const status = searchEnum(search.status, statuses)
  const sort = searchEnum(search.sort, sorts)
  const format = searchText(search.format)?.toLowerCase()
  return {
    ...searchEntry('repo', searchText(search.repo)),
    ...searchEntry('group', searchText(search.group)),
    ...searchEntry('status', status === 'policy' ? undefined : status),
    ...searchEntry('kind', searchEnum(search.kind, assetKinds)),
    ...searchEntry('format', format),
    ...searchEntry('problem', searchEnum(search.problem, problemRules)),
    ...searchEntry('sort', sort === 'severity' ? undefined : sort),
    ...searchEntry('q', searchText(search.q)),
  }
}

/** The `GET /api/assets` query of a search, defaults spelled out; `q` stays in the browser. */
export function toAssetsQuery(search: AssetsSearch): Omit<AssetsQuery, 'cursor'> {
  return {
    status: search.status ?? 'policy',
    sort: search.sort ?? 'severity',
    ...searchEntry('repo', search.repo),
    ...searchEntry('group', search.group),
    ...searchEntry('kind', search.kind),
    ...searchEntry('format', search.format),
    ...searchEntry('problem', search.problem),
  }
}
