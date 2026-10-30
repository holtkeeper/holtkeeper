import { relative } from 'node:path'

import { type Finding, type Severity, severityFromScore } from '@holtkeeper/vuln'
import { z } from 'zod'

const vulnerabilitySchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()).nullish(),
  summary: z.string().nullish(),
  database_specific: z.object({ severity: z.string().nullish() }).nullish(),
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

/** The subset of `osv-scanner --format json` output that findings are built from. */
export const osvScanOutputSchema = z.object({
  results: z
    .array(
      z.object({
        source: z.object({ path: z.string(), type: z.string() }),
        packages: z
          .array(
            z.object({
              package: z.object({ name: z.string(), version: z.string(), ecosystem: z.string() }),
              vulnerabilities: z.array(vulnerabilitySchema).nullish(),
              groups: z
                .array(
                  z.object({
                    ids: z.array(z.string()),
                    aliases: z.array(z.string()).nullish(),
                    max_severity: z.string().nullish(),
                  }),
                )
                .nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
})

export type OsvScanOutput = z.input<typeof osvScanOutputSchema>
type OsvVulnerability = z.output<typeof vulnerabilitySchema>

const advisorySeverity: Record<string, Severity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MODERATE: 'medium',
  MEDIUM: 'medium',
  LOW: 'low',
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
export function fixedVersionsFor(
  vulnerabilities: readonly OsvVulnerability[],
  pkg: { name: string; version: string; ecosystem: string },
): string[] {
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

function severityOf(
  score: string | null | undefined,
  vulnerabilities: OsvVulnerability[],
): Severity {
  const fromScore = severityFromScore(Number(score))
  if (fromScore !== 'unknown') return fromScore
  for (const vulnerability of vulnerabilities) {
    const label = vulnerability.database_specific?.severity?.toUpperCase()
    if (label && label in advisorySeverity) return advisorySeverity[label] ?? 'unknown'
  }
  return 'unknown'
}

/**
 * Converts osv-scanner JSON into findings, one per advisory group and package. osv-scanner groups
 * ids that describe the same issue (a GHSA and its CVE); the GHSA becomes the primary id.
 */
export function parseScanOutput(input: unknown, dir: string): Finding[] {
  const output = osvScanOutputSchema.parse(input)
  const findings: Finding[] = []
  for (const result of output.results ?? []) {
    const source = relative(dir, result.source.path)
    for (const { package: pkg, vulnerabilities: listed, groups } of result.packages ?? []) {
      const vulnerabilities = listed ?? []
      const groupList = groups ?? vulnerabilities.map((v) => ({ ids: [v.id], aliases: v.aliases }))
      for (const group of groupList) {
        const members = vulnerabilities.filter((v) => group.ids.includes(v.id))
        const id = group.ids.find((candidate) => candidate.startsWith('GHSA-')) ?? group.ids[0]
        if (!id) continue
        const aliases = new Set([
          ...group.ids,
          ...(group.aliases ?? []),
          ...members.flatMap((v) => v.aliases ?? []),
        ])
        aliases.delete(id)
        findings.push({
          id,
          aliases: [...aliases].toSorted(),
          summary: members.find((v) => v.id === id)?.summary ?? members[0]?.summary ?? '',
          severity: severityOf('max_severity' in group ? group.max_severity : undefined, members),
          url: `https://osv.dev/vulnerability/${id}`,
          package: { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem },
          source,
          fixedVersions: fixedVersionsFor(members, pkg),
        })
      }
    }
  }
  return findings
}
