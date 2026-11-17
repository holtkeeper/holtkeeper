import { relative } from 'node:path'

import { type Finding, type Severity, severityFromScore } from '@holtkeeper/vuln'
import { z } from 'zod'

import { type OsvRecord, fixedVersionsFor, labelSeverity, osvRecordSchema } from './records.ts'

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
              vulnerabilities: z.array(osvRecordSchema).nullish(),
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

function severityOf(score: string | null | undefined, vulnerabilities: OsvRecord[]): Severity {
  const fromScore = severityFromScore(Number(score))
  if (fromScore !== 'unknown') return fromScore
  for (const vulnerability of vulnerabilities) {
    const label = labelSeverity(vulnerability)
    if (label !== 'unknown') return label
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
