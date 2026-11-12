import type {
  LicenseDelta,
  LicensePolicySummary,
  LicenseVerdictName,
  LicensesOverview,
  LicensesRepoRow,
  LicenseViolation,
  Scope,
  SettingView,
} from '@holtkeeper/api'

import { searchEntry, searchEnum, searchList, searchText } from './search-params.ts'

/** Verdicts a violation can have. */
type ViolationVerdict = LicenseViolation['verdict']

/** Sort orders of the violations table; `verdict` is the default. */
export type LicensesSort = 'verdict' | 'license' | 'package' | 'repos'

const verdicts: readonly ViolationVerdict[] = ['denied', 'unlisted', 'unknown']
const sorts: readonly LicensesSort[] = ['verdict', 'license', 'package', 'repos']

/** Search parameters of `/supply/licenses`; omitted keys are the defaults. */
export interface LicensesSearch {
  /** `forge:path` the page narrows to. */
  repo?: string
  verdict?: ViolationVerdict[]
  ecosystem?: string[]
  sort?: Exclude<LicensesSort, 'verdict'>
  q?: string
  /** The violation open in the sheet: `<ecosystem>:<package>`. */
  package?: string
  /** Tab of the open violation's sheet. */
  tab?: string
}

/** Reads `/supply/licenses` search parameters, dropping unknown values and defaults. */
export function parseLicensesSearch(search: Record<string, unknown>): LicensesSearch {
  const sort = searchEnum(search.sort, sorts)
  return {
    ...searchEntry('repo', searchText(search.repo)),
    ...searchEntry('verdict', searchList(search.verdict, verdicts)),
    ...searchEntry('ecosystem', searchList(search.ecosystem)),
    ...searchEntry('sort', sort === 'verdict' ? undefined : sort),
    ...searchEntry('q', searchText(search.q)),
    ...searchEntry('package', searchText(search.package)),
    ...searchEntry('tab', searchText(search.tab)),
  }
}

/** Words of a verdict. */
export const verdictLabel: Record<LicenseVerdictName, string> = {
  denied: 'Denied',
  unlisted: 'Needs review',
  unknown: 'Unknown',
  allowed: 'Allowed',
  ignored: 'Ignored',
  internal: 'Internal',
  excepted: 'Excepted',
}

/** Packages of a repository's scan a policy exception accepts. */
export const exceptedCount = (row: Pick<LicensesRepoRow, 'verdicts'>): number =>
  row.verdicts.excepted

/** Tag tone of a verdict. */
export const verdictTone = (verdict: LicenseVerdictName): 'danger' | 'warning' | 'default' =>
  verdict === 'denied'
    ? 'danger'
    : verdict === 'unlisted' || verdict === 'unknown'
      ? 'warning'
      : 'default'

const verdictNames: readonly LicenseVerdictName[] = [
  'denied',
  'unlisted',
  'unknown',
  'allowed',
  'ignored',
  'internal',
  'excepted',
]

/** The verdict name a free-text verdict stands for, or undefined when it is none. */
export const parseVerdict = (value: string): LicenseVerdictName | undefined =>
  verdictNames.find((name) => name === value)

/** The sheet key of a violation: `<ecosystem>:<package>`. */
export const violationKey = (violation: LicenseViolation): string =>
  `${violation.ecosystem}:${violation.package}`

/** A violation as fleet tables take it: `groups` joins the groups of its repositories. */
export interface ViolationRow {
  key: string
  violation: LicenseViolation
  groups: string[]
}

/** Wraps violations as rows; one belongs to every team one of its repositories belongs to. */
export const violationRows = (violations: readonly LicenseViolation[]): ViolationRow[] =>
  violations.map((violation) => ({
    key: violationKey(violation),
    violation,
    groups: [...new Set(violation.repos.flatMap((repo) => repo.groups))].toSorted(),
  }))

const matchesText = (violation: LicenseViolation, q: string): boolean => {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [
    violation.package,
    violation.ecosystem,
    ...violation.licenses,
    ...violation.culprits,
    ...violation.repos.map((repo) => repo.repo),
  ].some((value) => value.toLowerCase().includes(needle))
}

/** Violations matching the search's verdict, ecosystem, repository and text filters. */
export function filterViolations(
  violations: readonly LicenseViolation[],
  search: Pick<LicensesSearch, 'verdict' | 'ecosystem' | 'repo' | 'q'>,
): LicenseViolation[] {
  return violations.filter(
    (violation) =>
      (!search.verdict?.length || search.verdict.includes(violation.verdict)) &&
      (!search.ecosystem?.length || search.ecosystem.includes(violation.ecosystem)) &&
      (!search.repo || violation.repos.some((repo) => repo.repo === search.repo)) &&
      matchesText(violation, search.q ?? ''),
  )
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })

const verdictOrder: Record<ViolationVerdict, number> = { denied: 0, unlisted: 1, unknown: 2 }

/** The license a row shows: the first declared expression, or `UNKNOWN`. */
export const violationLicense = (violation: LicenseViolation): string =>
  violation.licenses[0] ?? 'UNKNOWN'

/**
 * Violations in `sort` order: `verdict` denied first, then most repositories; `license` and
 * `package` by name; `repos` most repositories first. Ties keep the server's order.
 */
export function sortViolations(
  violations: readonly LicenseViolation[],
  sort: LicensesSort,
): LicenseViolation[] {
  const compare: Record<LicensesSort, (a: LicenseViolation, b: LicenseViolation) => number> = {
    verdict: (a, b) =>
      verdictOrder[a.verdict] - verdictOrder[b.verdict] || b.repos.length - a.repos.length,
    license: (a, b) => byName(violationLicense(a), violationLicense(b)),
    package: (a, b) => byName(a.package, b.package),
    repos: (a, b) => b.repos.length - a.repos.length,
  }
  return violations
    .map((violation, index) => ({ violation, index }))
    .toSorted((a, b) => compare[sort](a.violation, b.violation) || a.index - b.index)
    .map((entry) => entry.violation)
}

/** Repository rows matching the repository and text filters; worst first. */
export function filterLicenseRepos(
  rows: readonly LicensesRepoRow[],
  search: Pick<LicensesSearch, 'repo' | 'q'>,
): LicensesRepoRow[] {
  const needle = (search.q ?? '').trim().toLowerCase()
  return rows
    .filter(
      (row) =>
        (!search.repo || row.repo === search.repo) &&
        (!needle || row.repo.toLowerCase().includes(needle)),
    )
    .toSorted(
      (a, b) =>
        b.verdicts.denied - a.verdicts.denied ||
        b.verdicts.unlisted + b.verdicts.unknown - (a.verdicts.unlisted + a.verdicts.unknown) ||
        a.repo.localeCompare(b.repo),
    )
}

/** One part of the license mix bar. */
export interface MixPart {
  license: string
  packages: number
  /** Whole percent of all packages, at least 1 for a non-empty part. */
  percent: number
}

/**
 * The license mix as the `top` largest licenses plus one "N others" part for the rest; empty
 * when there are no packages.
 */
export function mixParts(mix: LicensesOverview['mix'], top = 5): MixPart[] {
  const total = mix.reduce((sum, entry) => sum + entry.packages, 0)
  if (!total) return []
  const percent = (packages: number) => Math.max(1, Math.round((packages / total) * 100))
  const head = mix.slice(0, top).map((entry) => ({
    license: entry.license,
    packages: entry.packages,
    percent: percent(entry.packages),
  }))
  const rest = mix.slice(top)
  if (!rest.length) return head
  const packages = rest.reduce((sum, entry) => sum + entry.packages, 0)
  return [...head, { license: `${rest.length} others`, packages, percent: percent(packages) }]
}

/** "+2 · 1 resolved" for a weekly delta; empty when nothing moved. */
export function deltaText(delta: LicenseDelta | undefined): string {
  if (!delta || (!delta.added && !delta.resolved)) return ''
  return [delta.added ? `+${delta.added}` : '', delta.resolved ? `${delta.resolved} resolved` : '']
    .filter(Boolean)
    .join(' · ')
}

/** The figures of the KPI strip, as numbers; captions carry weekly deltas when known. */
export interface LicenseKpis {
  packages: number
  repos: number
  denied: number
  review: number
  unknown: number
  licenses: number
  allowedLicenses: number
  missingLicenseFile: number
  internal: number
  /** Packages a policy exception accepts, added up over repositories. */
  excepted: number
}

/**
 * KPIs summed over the newest scans of `repos`, or for the whole overview without it. Distinct
 * licenses are only known fleet-wide, so a subset gets the count of its violations' licenses and
 * no allowed-license count.
 */
export function licenseKpis(overview: LicensesOverview, repos?: readonly string[]): LicenseKpis {
  if (!repos) {
    const { kpi } = overview
    return {
      packages: kpi.packages,
      repos: kpi.repos,
      denied: kpi.denied,
      review: kpi.review,
      unknown: kpi.unknown,
      licenses: kpi.licenses,
      allowedLicenses: kpi.allowedLicenses,
      missingLicenseFile: kpi.missingLicenseFile,
      internal: kpi.internal,
      excepted: overview.repos.reduce((n, row) => n + exceptedCount(row), 0),
    }
  }
  const wanted = new Set(repos)
  const rows = overview.repos.filter((entry) => wanted.has(entry.repo))
  const violations = overview.violations.filter((v) => v.repos.some((r) => wanted.has(r.repo)))
  const sum = (of: (row: LicensesRepoRow) => number) => rows.reduce((n, row) => n + of(row), 0)
  return {
    packages: sum((row) => row.packages),
    repos: rows.length,
    denied: sum((row) => row.verdicts.denied),
    review: sum((row) => row.verdicts.unlisted),
    unknown: sum((row) => row.verdicts.unknown),
    licenses: new Set(violations.flatMap((v) => (v.licenses.length ? v.licenses : ['UNKNOWN'])))
      .size,
    allowedLicenses: 0,
    missingLicenseFile: rows.filter((row) => row.licenseFile === 'missing').length,
    internal: sum((row) => row.verdicts.internal),
    excepted: sum(exceptedCount),
  }
}

/** Words of a repository's license file state. */
export const licenseFileLabel: Record<LicensesRepoRow['licenseFile'], string> = {
  present: 'Present',
  missing: 'Missing',
  'not-required': 'Not required',
}

/** The policy summary as label and text pairs, for a key–value list. */
export function policyFacts(policy: LicensePolicySummary): { label: string; value: string }[] {
  return [
    { label: 'Preset', value: policy.preset ?? 'Custom' },
    {
      label: 'Applies to',
      value: policy.overrides
        ? `All repositories, ${policy.overrides} narrower ${policy.overrides === 1 ? 'entry overrides' : 'entries override'} it`
        : 'All repositories',
    },
    { label: 'Unknown license', value: policy.unknown === 'violation' ? 'Violation' : 'Review' },
    {
      label: 'Repository license',
      value: policy.requireProjectLicense ? 'Required' : 'Not required',
    },
    {
      label: 'Dev-only dependencies',
      value: policy.devDependencies === 'ignore' ? 'Ignored' : 'Checked too',
    },
    { label: 'Ignored', value: policy.ignore.length ? policy.ignore.join(', ') : 'Nothing' },
    {
      label: 'Exceptions',
      value: policy.exceptions.length
        ? `${policy.exceptions.length} ${policy.exceptions.length === 1 ? 'package' : 'packages'}`
        : 'None',
    },
  ]
}

/** A license exception as `analyzers.licenses.exceptions` stores it. */
export interface LicenseException {
  package: string
  version?: string
  license?: string
  reason: string
  approvedBy?: string
  /** Last day, `YYYY-MM-DD`. */
  expires?: string
}

/** Where an exception is written: an existing `analyzers.licenses` entry or a new one. */
export interface ExceptionTarget {
  settingId?: string
  scope: Scope
  /** The entry's value, kept whole: a narrower entry replaces every field of a broader one. */
  value: Record<string, unknown>
  /** Repositories (`forge:path`) the target applies to. */
  reaches: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The entries a license exception for `repos` goes into. `winners` maps a repository to the
 * `analyzers.licenses` entry the resolver says applies there, or `null` when the defaults do;
 * `visible` is what the caller may read. Each readable applying entry is a target with the
 * repositories it reaches; repositories on the defaults get one new entry scoped to them, which
 * changes nothing else since it starts from the defaults too. Repositories whose entry the caller
 * cannot read are `blocked`.
 */
export function exceptionTargets(
  repos: readonly string[],
  winners: ReadonlyMap<string, SettingView | null>,
  visible: readonly SettingView[],
): { targets: ExceptionTarget[]; blocked: string[] } {
  const readable = new Set(visible.map((setting) => setting.id))
  const byId = new Map<string, ExceptionTarget>()
  const uncovered: string[] = []
  const blocked: string[] = []
  for (const repo of repos) {
    const winner = winners.get(repo)
    if (winner === null) uncovered.push(repo)
    else if (!winner || !readable.has(winner.id)) blocked.push(repo)
    else {
      const target = byId.get(winner.id) ?? {
        settingId: winner.id,
        scope: winner.scope,
        value: isObject(winner.value) ? winner.value : {},
        reaches: [],
      }
      target.reaches.push(repo)
      byId.set(winner.id, target)
    }
  }
  const targets = [...byId.values()].toSorted((a, b) => b.reaches.length - a.reaches.length)
  return {
    targets: uncovered.length
      ? [...targets, { scope: { repos: uncovered }, value: {}, reaches: uncovered }]
      : targets,
    blocked,
  }
}

/**
 * `value` with `exception` added to its `exceptions`; an exception for the same package, version
 * and license is replaced, so adding it twice updates the reason and last day.
 */
export function withLicenseException(
  value: Record<string, unknown>,
  exception: LicenseException,
): Record<string, unknown> {
  const current = Array.isArray(value.exceptions) ? value.exceptions.filter(isObject) : []
  const same = (entry: Record<string, unknown>) =>
    entry.package === exception.package &&
    entry.version === exception.version &&
    entry.license === exception.license
  return { ...value, exceptions: [...current.filter((entry) => !same(entry)), exception] }
}

/** A short note asking the package's users for an alternative, for chat or a ticket. */
export const alternativeRequest = (violation: LicenseViolation): string =>
  [
    `${violation.package} (${violation.ecosystem} ${violation.versions.join(', ')}) is ${verdictLabel[violation.verdict].toLowerCase()} under ${violationLicense(violation)} by our license policy.`,
    `Used in: ${violation.repos.map((entry) => entry.repo).join(', ')}.`,
    'Please replace it with a package under an allowed license, or ask for an exception with a reason and a last day.',
  ].join('\n')
