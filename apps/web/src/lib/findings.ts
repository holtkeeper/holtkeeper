import { type Finding, type Severity, type SourceInfo, sourceInfo } from '@holtkeeper/api'

import { severityRank } from './severity.ts'

/** A finding with its package manager and language resolved, as the findings table uses it. */
export interface FindingRow {
  /** Unique within a report: advisory, package, version and source. */
  key: string
  finding: Finding
  info: SourceInfo
}

/** Builds rows for the findings table. Keys stay unique even for duplicate findings. */
export function toRows(findings: readonly Finding[]): FindingRow[] {
  const seen = new Map<string, number>()
  return findings.map((finding) => {
    const base = `${finding.id}|${finding.package.name}@${finding.package.version}|${finding.source}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return { key: count ? `${base}#${count}` : base, finding, info: sourceInfo(finding.source) }
  })
}

/** Rows worst severity first, then by package name and advisory id. */
export function sortFindingRows(rows: readonly FindingRow[]): FindingRow[] {
  return rows.toSorted(
    (a, b) =>
      severityRank(a.finding.severity) - severityRank(b.finding.severity) ||
      a.finding.package.name.localeCompare(b.finding.package.name) ||
      a.finding.id.localeCompare(b.finding.id),
  )
}

/** Rows of the given severities (all when empty) that match the free-text search. */
export const filterFindingRows = (
  rows: readonly FindingRow[],
  search: string,
  severities: readonly Severity[] = [],
): FindingRow[] =>
  rows.filter(
    (row) =>
      (!severities.length || severities.includes(row.finding.severity)) &&
      matchesSearch(row, search),
  )

/** Whether a row matches free-text search over package, advisory ids, summary and source. */
export function matchesSearch(row: FindingRow, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  const { finding } = row
  return [
    finding.package.name,
    finding.package.version,
    finding.id,
    ...finding.aliases,
    finding.summary,
    finding.source,
    row.info.label,
    row.info.language,
  ].some((value) => value.toLowerCase().includes(needle))
}

/** Lowest fixed version, or `undefined` when no fix exists. */
export const firstFix = (finding: Finding): string | undefined => finding.fixedVersions[0]
