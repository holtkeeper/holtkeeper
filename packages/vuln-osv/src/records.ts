import {
  type Finding,
  type PackageRef,
  type Severity,
  compareSeverity,
  severityFromScore,
} from '@holtkeeper/vuln'
import { z } from 'zod'

import { cvss3BaseScore } from './cvss.ts'

/**
 * The fields of an OSV vulnerability record (`GET /v1/vulns/<id>`, or an entry of osv-scanner's
 * JSON) that findings are built from. Unknown fields are dropped.
 */
export const osvRecordSchema = z.object({
  id: z.string(),
  modified: z.string().nullish(),
  withdrawn: z.string().nullish(),
  aliases: z.array(z.string()).nullish(),
  summary: z.string().nullish(),
  severity: z
    .array(z.object({ type: z.string().nullish(), score: z.string().nullish() }))
    .nullish()
    .catch(undefined),
  database_specific: z
    .object({ severity: z.string().nullish().catch(undefined) })
    .nullish()
    .catch(undefined),
  affected: z
    .array(
      z.object({
        package: z.object({ name: z.string(), ecosystem: z.string() }).nullish(),
        ranges: z
          .array(
            z.object({
              type: z.string(),
              events: z.array(
                z.object({ introduced: z.string().optional(), fixed: z.string().optional() }),
              ),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
})

/** An OSV vulnerability record as `osvRecordSchema` keeps it. */
export type OsvRecord = z.output<typeof osvRecordSchema>

const advisorySeverity: Record<string, Severity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MODERATE: 'medium',
  MEDIUM: 'medium',
  LOW: 'low',
}

/** The GHSA severity label of a record (`database_specific.severity`), `unknown` without one. */
export function labelSeverity(record: OsvRecord): Severity {
  const label = record.database_specific?.severity?.toUpperCase()
  return (label && advisorySeverity[label]) || 'unknown'
}

const maxSeverity = (severities: Iterable<Severity>): Severity => {
  let max: Severity = 'unknown'
  for (const severity of severities) if (compareSeverity(severity, max) > 0) max = severity
  return max
}

/**
 * The severity of records describing one issue: from the highest CVSS 3 base score among them,
 * else the highest GHSA label, else `unknown`.
 */
export function recordsSeverity(records: readonly OsvRecord[]): Severity {
  const scores = records.flatMap((record) =>
    (record.severity ?? []).flatMap((entry) => {
      const score = entry.score ? cvss3BaseScore(entry.score) : undefined
      return score === undefined ? [] : [score]
    }),
  )
  if (scores.length) return severityFromScore(Math.max(...scores))
  return maxSeverity(records.map(labelSeverity))
}

function compare(a: string, b: string): number | undefined {
  try {
    return Bun.semver.order(a, b)
  } catch {
    return undefined
  }
}

/**
 * Fixed versions for the ranges that contain `version`. Ecosystems whose versions are not semver
 * cannot be compared here, so every fixed version of the package is returned for them.
 */
export function fixedVersionsFor(vulnerabilities: readonly OsvRecord[], pkg: PackageRef): string[] {
  const all = new Set<string>()
  const applicable = new Set<string>()
  let comparable = true

  for (const vulnerability of vulnerabilities) {
    for (const affected of vulnerability.affected ?? []) {
      if (affected.package?.name !== pkg.name || affected.package.ecosystem !== pkg.ecosystem)
        continue
      for (const range of affected.ranges ?? []) {
        if (range.type === 'GIT') continue
        let introduced = '0'
        for (const event of range.events) {
          if (event.introduced !== undefined) introduced = event.introduced
          if (event.fixed === undefined) continue
          all.add(event.fixed)
          const afterStart = introduced === '0' ? 0 : compare(pkg.version, introduced)
          const beforeFix = compare(pkg.version, event.fixed)
          if (afterStart === undefined || beforeFix === undefined) comparable = false
          else if (afterStart >= 0 && beforeFix < 0) applicable.add(event.fixed)
        }
      }
    }
  }

  const versions = [...(comparable ? applicable : all)]
  return comparable ? versions.toSorted((a, b) => compare(a, b) ?? 0) : versions
}

/** Records that share an id or alias, transitively: one issue under several databases' ids. */
function groupRecords(records: readonly OsvRecord[]): OsvRecord[][] {
  let groups: { names: Set<string>; members: OsvRecord[] }[] = []
  for (const record of records) {
    const names = new Set([record.id, ...(record.aliases ?? [])])
    const joined = { names, members: [record] }
    const rest: typeof groups = []
    for (const group of groups) {
      if ([...names].some((name) => group.names.has(name))) {
        for (const name of group.names) joined.names.add(name)
        joined.members.push(...group.members)
      } else rest.push(group)
    }
    groups = [...rest, joined]
  }
  return groups.map((group) => group.members.toSorted((a, b) => a.id.localeCompare(b.id)))
}

/**
 * Findings for one package version found in `source`, from the OSV records that affect it: one
 * per issue, where records sharing an id or alias are one issue (a GHSA and the Go or CVE record
 * of the same problem). The GHSA id is primary when the issue has one; withdrawn records are left
 * out. The result is sorted by primary id.
 */
export function findingsForPackage(
  pkg: PackageRef,
  source: string,
  records: readonly OsvRecord[],
): Finding[] {
  const live = records
    .filter((record) => !record.withdrawn)
    .toSorted((a, b) => a.id.localeCompare(b.id))
  return groupRecords(live)
    .map((members): Finding => {
      const primary = members.find((member) => member.id.startsWith('GHSA-')) ?? members[0]
      // groupRecords never returns an empty group
      const id = primary?.id ?? ''
      const aliases = new Set(members.flatMap((member) => [member.id, ...(member.aliases ?? [])]))
      aliases.delete(id)
      return {
        id,
        aliases: [...aliases].toSorted(),
        summary: primary?.summary ?? members.find((member) => member.summary)?.summary ?? '',
        severity: recordsSeverity(members),
        url: `https://osv.dev/vulnerability/${id}`,
        package: { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem },
        source,
        fixedVersions: fixedVersionsFor(members, pkg),
      }
    })
    .toSorted((a, b) => a.id.localeCompare(b.id))
}
