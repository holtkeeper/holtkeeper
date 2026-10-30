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

interface PackageGroup {
  key: string
  name: string
  version: string
  ecosystem: string
  worst: Severity
  rows: FindingRow[]
}

interface SourceGroup {
  source: string
  worst: Severity
  count: number
  packages: PackageGroup[]
}

interface ToolGroup {
  label: string
  tool: SourceInfo['tool']
  worst: Severity
  count: number
  sources: SourceGroup[]
}

export interface LanguageGroup {
  language: string
  worst: Severity
  count: number
  tools: ToolGroup[]
}

const worse = (a: Severity, b: Severity): Severity => (severityRank(a) <= severityRank(b) ? a : b)

function bucket<T>(map: Map<string, T>, key: string, create: () => T): T {
  let value = map.get(key)
  if (!value) {
    value = create()
    map.set(key, value)
  }
  return value
}

/**
 * Groups rows as Language → package manager → source file → package. Groups appear in the order
 * of their first row, so sorting the rows first (worst severity first, say) orders the groups too.
 */
export function groupFindings(rows: readonly FindingRow[]): LanguageGroup[] {
  const languages = new Map<
    string,
    {
      group: LanguageGroup
      tools: Map<
        string,
        {
          group: ToolGroup
          sources: Map<string, { group: SourceGroup; packages: Map<string, PackageGroup> }>
        }
      >
    }
  >()
  for (const row of rows) {
    const { finding, info } = row
    const severity = finding.severity
    const language = bucket(languages, info.language, () => ({
      group: { language: info.language, worst: severity, count: 0, tools: [] },
      tools: new Map(),
    }))
    const tool = bucket(language.tools, info.label, () => {
      const group: ToolGroup = {
        label: info.label,
        tool: info.tool,
        worst: severity,
        count: 0,
        sources: [],
      }
      language.group.tools.push(group)
      return { group, sources: new Map() }
    })
    const source = bucket(tool.sources, finding.source, () => {
      const group: SourceGroup = { source: finding.source, worst: severity, count: 0, packages: [] }
      tool.group.sources.push(group)
      return { group, packages: new Map() }
    })
    const packageKey = `${finding.package.name}@${finding.package.version}`
    const pkg = bucket(source.packages, packageKey, () => {
      const group: PackageGroup = {
        key: `${finding.source}|${packageKey}`,
        name: finding.package.name,
        version: finding.package.version,
        ecosystem: finding.package.ecosystem,
        worst: severity,
        rows: [],
      }
      source.group.packages.push(group)
      return group
    })
    pkg.rows.push(row)
    pkg.worst = worse(pkg.worst, severity)
    for (const group of [source.group, tool.group, language.group]) {
      group.count++
      group.worst = worse(group.worst, severity)
    }
  }
  return [...languages.values()].map((entry) => entry.group)
}

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

/** Distinct languages and package-manager labels among rows, sorted, for filter menus. */
export function facets(rows: readonly FindingRow[]): { languages: string[]; tools: string[] } {
  return {
    languages: [...new Set(rows.map((row) => row.info.language))].toSorted(),
    tools: [...new Set(rows.map((row) => row.info.label))].toSorted(),
  }
}

/** Lowest fixed version, or `undefined` when no fix exists. */
export const firstFix = (finding: Finding): string | undefined => finding.fixedVersions[0]
