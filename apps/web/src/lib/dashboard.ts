import {
  type AuditReport,
  type AuditRunSummary,
  type RepoSummary,
  type Severity,
  type SeverityCounts,
  emptySeverities,
  sourceInfo,
} from '@holtkeeper/api'

import { repoKey } from './repo.ts'
import { addCounts, compareCounts, severityRank } from './severity.ts'

/** Severity counts summed over the latest audit of every repository. */
export function latestTotals(repos: readonly RepoSummary[]): SeverityCounts & {
  active: number
  ignored: number
  resolved: number
  expiredAllowlist: number
} {
  let severities = emptySeverities()
  let active = 0
  let ignored = 0
  let resolved = 0
  let expiredAllowlist = 0
  for (const { latestAudit } of repos) {
    if (!latestAudit) continue
    severities = addCounts(severities, latestAudit.severities)
    active += latestAudit.active
    ignored += latestAudit.ignored
    resolved += latestAudit.resolved
    expiredAllowlist += latestAudit.expiredAllowlist
  }
  return { ...severities, active, ignored, resolved, expiredAllowlist }
}

/** One day of the active-findings trend: severities of every repository's latest run that day. */
export interface TrendPoint extends SeverityCounts {
  day: string
  total: number
}

/**
 * Active findings per day over the last `days` days, counting for each repository the latest run
 * that finished by the end of that day. Repositories without a run yet count as zero.
 */
export function activeTrend(
  runs: readonly AuditRunSummary[],
  days: number,
  now: Date = new Date(),
): TrendPoint[] {
  const byRepo = new Map<string, AuditRunSummary[]>()
  for (const run of runs) {
    const list = byRepo.get(repoKey(run.repo)) ?? []
    list.push(run)
    byRepo.set(repoKey(run.repo), list)
  }
  for (const list of byRepo.values()) list.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))

  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const points: TrendPoint[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const dayStart = new Date(end.getTime() - offset * 86_400_000)
    const cutoff = new Date(dayStart.getTime() + 86_400_000).toISOString()
    let counts = emptySeverities()
    for (const list of byRepo.values()) {
      const latest = list.findLast((run) => run.finishedAt < cutoff)
      if (latest) counts = addCounts(counts, latest.severities)
    }
    const total = counts.critical + counts.high + counts.medium + counts.low + counts.unknown
    points.push({ day: dayStart.toISOString().slice(0, 10), ...counts, total })
  }
  return points
}

export interface Slice {
  name: string
  count: number
}

const toSlices = (counts: Map<string, number>): Slice[] =>
  [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name))

/** Active findings by language and by package manager across reports. */
export function breakdown(reports: readonly AuditReport[]): { languages: Slice[]; tools: Slice[] } {
  const languages = new Map<string, number>()
  const tools = new Map<string, number>()
  for (const report of reports) {
    for (const finding of report.findings) {
      const info = sourceInfo(finding.source)
      languages.set(info.language, (languages.get(info.language) ?? 0) + 1)
      tools.set(info.label, (tools.get(info.label) ?? 0) + 1)
    }
  }
  return { languages: toSlices(languages), tools: toSlices(tools) }
}

/**
 * Breakdown when only summaries are available: how many repositories use each language or
 * package manager among their findings.
 */
export function breakdownFromSummaries(summaries: readonly AuditRunSummary[]): {
  languages: Slice[]
  tools: Slice[]
} {
  const languages = new Map<string, number>()
  const tools = new Map<string, number>()
  for (const summary of summaries) {
    for (const language of summary.languages)
      languages.set(language, (languages.get(language) ?? 0) + 1)
    for (const tool of summary.tools) tools.set(tool, (tools.get(tool) ?? 0) + 1)
  }
  return { languages: toSlices(languages), tools: toSlices(tools) }
}

export interface AffectedPackage {
  name: string
  ecosystem: string
  findings: number
  repos: number
  worst: Severity
}

/** Packages with the most active findings across reports, worst first on ties. */
export function topPackages(
  reports: readonly { repo: string; report: AuditReport }[],
  limit = 8,
): AffectedPackage[] {
  const packages = new Map<string, AffectedPackage & { repoSet: Set<string> }>()
  for (const { repo, report } of reports) {
    for (const finding of report.findings) {
      const key = `${finding.package.ecosystem}|${finding.package.name}`
      let entry = packages.get(key)
      if (!entry) {
        entry = {
          name: finding.package.name,
          ecosystem: finding.package.ecosystem,
          findings: 0,
          repos: 0,
          worst: finding.severity,
          repoSet: new Set(),
        }
        packages.set(key, entry)
      }
      entry.findings++
      entry.repoSet.add(repo)
      entry.repos = entry.repoSet.size
      if (severityRank(finding.severity) < severityRank(entry.worst)) entry.worst = finding.severity
    }
  }
  return [...packages.values()]
    .toSorted(
      (a, b) =>
        b.findings - a.findings ||
        severityRank(a.worst) - severityRank(b.worst) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map(({ repoSet: _repoSet, ...entry }) => entry)
}

/** Repositories with active findings, worst first. */
export function needsAttention(repos: readonly RepoSummary[], limit = 6): RepoSummary[] {
  return repos
    .filter(
      (repo) =>
        (repo.latestAudit?.active ?? 0) > 0 || (repo.latestAudit?.expiredAllowlist ?? 0) > 0,
    )
    .toSorted((a, b) => compareCounts(a.latestAudit!.severities, b.latestAudit!.severities))
    .slice(0, limit)
}

/** Active findings of runs in chronological order, for sparklines. */
export const sparkline = (runs: readonly AuditRunSummary[]): { at: string; active: number }[] =>
  runs
    .toSorted((a, b) => a.finishedAt.localeCompare(b.finishedAt))
    .map((run) => ({ at: run.finishedAt, active: run.active }))
