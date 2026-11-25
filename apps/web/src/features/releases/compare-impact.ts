import type {
  DependencyRoot,
  DirectDependencyChange,
  PackageDiff,
  ReleaseCompareApi,
  ReleaseCompareCheck,
  UpgradeFinding,
  UpgradeSeverity,
  UpgradeVerdict,
} from '@holtkeeper/api'

import type { StatusTone } from '../../ui/colors.ts'

type Bump = PackageDiff['required']

const counted = (parts: readonly [number, string][]) =>
  parts
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(', ')

/** Changes of a package's public API in words, breaking kinds first, e.g. `2 removed, 1 added`. */
export const apiCounts = (
  diff: Pick<PackageDiff, 'removed' | 'changed' | 'deprecated' | 'added'>,
): string =>
  counted([
    [diff.removed, 'removed'],
    [diff.changed, 'changed'],
    [diff.deprecated, 'deprecated'],
    [diff.added, 'added'],
  ])

/**
 * Whether an API diff breaks callers: its changes call for a major bump (something was removed or
 * lost members), the rule `breaksCallers` of `@holtkeeper/api-surface` the server sorts by.
 */
export const apiBreaks = (diff: Pick<PackageDiff, 'required'>): boolean => diff.required === 'major'

const bumpRank: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 }

/**
 * Whether the version numbers moved less than the API changes call for (`bumped` below
 * `required`); false when either is unknown.
 */
export const underBumped = (diff: Pick<PackageDiff, 'required' | 'bumped'>): boolean =>
  diff.bumped !== undefined && bumpRank[diff.bumped] < bumpRank[diff.required]

const sideWords: Record<ReleaseCompareApi['missing'][number]['side'], string> = {
  from: 'at the start',
  to: 'at the end',
  both: 'at either end',
}

/**
 * Packages without a public API record, grouped by the end they lack it at, e.g.
 * `widget-kit at the start; some-lib, other-lib at either end`; empty when nothing is missing.
 */
export const missingText = (missing: ReleaseCompareApi['missing']): string =>
  (['from', 'to', 'both'] as const)
    .map((side) => {
      const names = missing.filter((entry) => entry.side === side).map((entry) => entry.name)
      return names.length ? `${names.join(', ')} ${sideWords[side]}` : ''
    })
    .filter(Boolean)
    .join('; ')

/** Input of `GET /api/releases/compare/package` for one direct dependency change. */
export interface PackageQuery {
  package: string
  ecosystem: 'npm' | 'Go'
  from?: string
  to?: string
}

/**
 * What to ask the package endpoint about a direct change: the package, its ecosystem and the
 * resolved versions at each side (declared ranges are left out, the server then uses what the
 * repository resolves). `undefined` for removed packages, which have nothing new to read.
 */
export function packageQuery(
  root: Pick<DependencyRoot, 'ecosystem'>,
  change: Pick<DirectDependencyChange, 'name' | 'change' | 'from' | 'to'>,
): PackageQuery | undefined {
  if (change.change === 'removed') return undefined
  return {
    package: change.name,
    ecosystem: root.ecosystem === 'go' ? 'Go' : 'npm',
    ...(change.from?.version ? { from: change.from.version } : {}),
    ...(change.to?.version ? { to: change.to.version } : {}),
  }
}

/** Tag tone and label of a breaking-change check verdict. */
export const verdictTags: Record<UpgradeVerdict, { tone: StatusTone; label: string }> = {
  safe: { tone: 'success', label: 'Safe to upgrade' },
  review: { tone: 'warning', label: 'Review before upgrading' },
  breaking: { tone: 'danger', label: 'Breaks' },
}

/** Tag tone and heading of a finding severity. */
export const severityTags: Record<UpgradeSeverity, { tone: StatusTone; label: string }> = {
  breaking: { tone: 'danger', label: 'Breaking' },
  risky: { tone: 'warning', label: 'Risky' },
  info: { tone: 'info', label: 'Worth knowing' },
}

/** Findings grouped by severity, breaking first; empty groups are dropped, order kept inside. */
export const findingGroups = (
  findings: readonly UpgradeFinding[],
): { severity: UpgradeSeverity; findings: UpgradeFinding[] }[] =>
  (['breaking', 'risky', 'info'] as const)
    .map((severity) => ({
      severity,
      findings: findings.filter((finding) => finding.severity === severity),
    }))
    .filter((group) => group.findings.length > 0)

/** A finding's file as shown and linked: `path:line`, or the path alone. */
export const fileLocation = (file: { path: string; line?: number }): string =>
  file.line ? `${file.path}:${file.line}` : file.path

/** The check is queued or running, so the page keeps polling and shows progress. */
export const checkActive = (check: Pick<ReleaseCompareCheck, 'status'> | undefined): boolean =>
  check?.status === 'queued' || check?.status === 'running'

/**
 * What the check's button does: `start` (never run, or failed without an earlier result), `again`
 * (a result exists, run with `force`) or nothing while a run is queued or running.
 */
export function checkAction(
  check: Pick<ReleaseCompareCheck, 'status' | 'data'> | undefined,
): 'start' | 'again' | undefined {
  if (!check || checkActive(check)) return undefined
  return check.status === 'none' || (check.status === 'failed' && !check.data) ? 'start' : 'again'
}

/** Changed files no agent read, in words, e.g. `12 files: lockfile or generated`; one line each. */
export const skippedLines = (skipped: readonly { files: number; reason: string }[]): string[] =>
  skipped
    .filter((entry) => entry.files > 0)
    .map((entry) => `${entry.files} ${entry.files === 1 ? 'file' : 'files'}: ${entry.reason}`)
