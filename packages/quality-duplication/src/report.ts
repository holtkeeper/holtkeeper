import type { DuplicationSummary, QualityIssue } from '@holtkeeper/quality'
import { stableId } from '@holtkeeper/quality'
import { z } from 'zod'

const location = z.object({ line: z.number().int(), column: z.number().int().optional() })

const fragment = z.object({
  name: z.string(),
  start: z.number().int(),
  end: z.number().int(),
  startLoc: location.optional(),
  endLoc: location.optional(),
})

const totals = z.object({
  lines: z.number(),
  duplicatedLines: z.number(),
  percentage: z.number(),
  clones: z.number().optional(),
})

/** The parts of jscpd's JSON report (`--reporters json`) this module reads. */
export const jscpdReportSchema = z.object({
  duplicates: z.array(
    z.object({
      format: z.string().optional(),
      lines: z.number().int(),
      tokens: z.number().int().optional(),
      fragment: z.string().optional(),
      kind: z.string().optional(),
      firstFile: fragment,
      secondFile: fragment,
    }),
  ),
  statistics: z.object({ total: totals }),
})

export type JscpdReport = z.infer<typeof jscpdReportSchema>

/** When a clone counts as large and is reported as a `warning` instead of `info`. */
export interface LargeClone {
  /** Default 50. */
  lines?: number
  /** Default 400. */
  tokens?: number
}

export interface ParsedDuplication {
  duplication: DuplicationSummary
  issues: QualityIssue[]
}

const clean = (name: string) => name.replace(/\\/g, '/').replace(/^\.\//, '')

/**
 * Turns a jscpd JSON report into the duplication summary and one issue per clone. The issue sits
 * on the first copy; `message` names both locations and `help` points at the other copy. The id
 * depends on both files and the duplicated text, not on line numbers. Throws on another shape.
 */
export function parseJscpdReport(report: unknown, large: LargeClone = {}): ParsedDuplication {
  const { duplicates, statistics } = jscpdReportSchema.parse(
    typeof report === 'string' ? JSON.parse(report) : report,
  )
  const largeLines = large.lines ?? 50
  const largeTokens = large.tokens ?? 400

  const issues = duplicates.map((clone): QualityIssue => {
    const first = clean(clone.firstFile.name)
    const second = clean(clone.secondFile.name)
    const where = (file: string, part: typeof clone.firstFile) =>
      `${file}:${part.start}-${part.end}`
    const size = `${clone.lines} lines${clone.tokens === undefined ? '' : ` (${clone.tokens} tokens)`}`
    const isLarge = clone.lines >= largeLines || (clone.tokens ?? 0) >= largeTokens
    return {
      id: stableId(
        'jscpd',
        'clone',
        first,
        second,
        clone.fragment ?? `${clone.lines}:${clone.tokens}`,
      ),
      tool: 'jscpd',
      rule: clone.kind ? `clone/${clone.kind}` : 'clone',
      category: 'duplication',
      severity: isLarge ? 'warning' : 'info',
      message: `${size} duplicated in ${where(first, clone.firstFile)} and ${where(second, clone.secondFile)}`,
      file: first,
      range: {
        start: { line: clone.firstFile.start, column: 1 },
        end: { line: clone.firstFile.end + 1, column: 1 },
      },
      help: `The same code is at ${where(second, clone.secondFile)}. Extract it into one shared function or module and call it from both places.`,
    }
  })

  const { total } = statistics
  return {
    duplication: {
      percentage: total.percentage,
      duplicatedLines: total.duplicatedLines,
      totalLines: total.lines,
    },
    issues,
  }
}
