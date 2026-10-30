import { isAbsolute, relative } from 'node:path'

import type { QualityIssue } from '@holtkeeper/quality'
import { stableId } from '@holtkeeper/quality'
import { z } from 'zod'

/** Name issues carry in `tool`. */
export const TOOL = 'gitleaks'

/** One entry of `gitleaks --report-format json`; only the fields issues are built from. */
export const gitleaksFindingSchema = z.object({
  RuleID: z.string(),
  Description: z.string().nullish(),
  StartLine: z.number().int(),
  EndLine: z.number().int().nullish(),
  StartColumn: z.number().int().nullish(),
  EndColumn: z.number().int().nullish(),
  File: z.string(),
  Commit: z.string().nullish(),
  Author: z.string().nullish(),
  Date: z.string().nullish(),
  Fingerprint: z.string().nullish(),
  Tags: z.array(z.string()).nullish(),
})

/** A gitleaks JSON report: an array of findings (`null` when gitleaks wrote nothing). */
export const gitleaksReportSchema = z.array(gitleaksFindingSchema).nullable()

export type GitleaksFinding = z.output<typeof gitleaksFindingSchema>

export interface ParseGitleaksOptions {
  /** Directory gitleaks scanned; absolute paths in the report are made relative to it. */
  dir: string
}

const toRelative = (dir: string, file: string) =>
  isAbsolute(file) ? relative(dir, file) : file.replace(/^\.\//, '')

/**
 * gitleaks 8.30 reports columns one too large on every line but the first of a file (it counts
 * the preceding newline). Columns come back 1-based with an exclusive end.
 */
function rangeOf(finding: GitleaksFinding): QualityIssue['range'] {
  const startLine = Math.max(1, finding.StartLine)
  const endLine = Math.max(startLine, finding.EndLine ?? startLine)
  if (!finding.StartColumn || !finding.EndColumn)
    return { start: { line: startLine, column: 1 }, end: { line: endLine + 1, column: 1 } }
  const startColumn = Math.max(1, finding.StartColumn - (startLine > 1 ? 1 : 0))
  const endColumn = finding.EndColumn + (endLine > 1 ? 0 : 1)
  return {
    start: { line: startLine, column: startColumn },
    end: {
      line: endLine,
      column: Math.max(endColumn, startLine === endLine ? startColumn + 1 : 1),
    },
  }
}

/** The fingerprint with the scanned directory stripped, so it does not depend on the checkout path. */
function fingerprintOf(finding: GitleaksFinding, dir: string, file: string): string {
  const raw = finding.Fingerprint ?? `${finding.Commit ?? ''}:${file}:${finding.RuleID}`
  return finding.File && raw.includes(finding.File)
    ? raw.replace(finding.File, file)
    : raw.replace(dir, '')
}

function helpOf(finding: GitleaksFinding): string {
  const lines = [
    'Rotate the secret, then remove it from the code; add it to `.gitleaksignore` only if it is not a real secret.',
  ]
  if (finding.Commit) {
    const by = finding.Author ? ` by ${finding.Author}` : ''
    const on = finding.Date ? ` on ${finding.Date}` : ''
    lines.unshift(
      `Introduced in commit ${finding.Commit}${by}${on}. It stays in the history until the history is rewritten.`,
    )
  }
  return lines.join('\n')
}

/**
 * Converts a gitleaks JSON report into `security` errors. The report must come from a run with
 * `--redact`; no field that can hold the secret (`Match`, `Secret`, `Line`) is read, so issues never
 * contain it. Findings of a history scan carry the commit, author and date in `help`.
 * `id = stableId(tool, rule, file, fingerprint)` with the fingerprint made relative to `dir`.
 */
export function parseGitleaksReport(input: unknown, { dir }: ParseGitleaksOptions): QualityIssue[] {
  const findings = gitleaksReportSchema.parse(input) ?? []
  return findings.map((finding) => {
    const file = toRelative(dir, finding.File)
    const where = finding.Commit ? ` (commit ${finding.Commit.slice(0, 12)})` : ''
    return {
      id: stableId(TOOL, finding.RuleID, file, fingerprintOf(finding, dir, file)),
      tool: TOOL,
      rule: finding.RuleID,
      category: 'security',
      severity: 'error',
      message: `${finding.Description?.trim() || `Possible secret (${finding.RuleID})`}${where}`,
      file,
      range: rangeOf(finding),
      help: helpOf(finding),
    }
  })
}
