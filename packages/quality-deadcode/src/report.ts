import { z } from 'zod'

const symbolSchema = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  line: z.number().int().optional(),
  col: z.number().int().optional(),
  pos: z.number().int().optional(),
})

/** One symbol in a knip JSON report: a file, dependency, export or member, with its 1-based position. */
export type KnipSymbol = z.infer<typeof symbolSchema>

const symbols = z.array(symbolSchema).optional()

const rowSchema = z.object({
  file: z.string(),
  files: symbols,
  dependencies: symbols,
  devDependencies: symbols,
  optionalPeerDependencies: symbols,
  unlisted: symbols,
  binaries: symbols,
  unresolved: symbols,
  exports: symbols,
  nsExports: symbols,
  types: symbols,
  nsTypes: symbols,
  enumMembers: symbols,
  namespaceMembers: symbols,
  classMembers: symbols,
  catalog: symbols,
  catalogReferences: symbols,
  duplicates: z.array(z.array(symbolSchema)).optional(),
  cycles: z.array(z.array(symbolSchema)).optional(),
})

/** Findings of one file in a knip JSON report, grouped by issue type. */
export type KnipRow = z.infer<typeof rowSchema>

/** The `--reporter json` output of knip 6: one row per file that has findings. */
export const knipReportSchema = z.object({ issues: z.array(rowSchema) })

export type KnipReport = z.infer<typeof knipReportSchema>

/**
 * Parses knip's JSON reporter output. Text knip or its plugins print before the report is
 * skipped. Throws when there is no report of that shape.
 */
export function parseKnipReport(output: unknown): KnipReport {
  if (typeof output !== 'string') return knipReportSchema.parse(output)
  const start = output.indexOf('{"issues"')
  const json: unknown = JSON.parse(start > 0 ? output.slice(start) : output)
  return knipReportSchema.parse(json)
}
