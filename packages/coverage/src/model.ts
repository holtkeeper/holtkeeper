import { z } from 'zod'

/** Covered and total units of one measure. */
export interface Counts {
  covered: number
  total: number
}

/** Coverage of one source file. */
export interface FileCoverageData {
  /** Relative to the checkout, `/`-separated. */
  file: string
  lines: Counts
  functions?: Counts
  branches?: Counts
  /** `false` when no test loaded the file; its code lines count as uncovered. */
  loaded?: false
}

/** Everything a `coverage` analysis found; serializable, stored as analysis data. */
export interface CoverageData {
  /** Collectors that produced the report, e.g. `vitest --coverage`, `go test -coverprofile`. */
  tools: string[]
  /** Language families the report judged: `js`, `go`, `python`. */
  languages: string[]
  /** Over every file, including files no test loaded. */
  summary: { lines: Counts; functions?: Counts; branches?: Counts }
  files: FileCoverageData[]
}

const counts = z.object({ covered: z.number(), total: z.number() })

/** Validates `CoverageData` uploads. */
export const coverageDataSchema: z.ZodType<CoverageData> = z.object({
  tools: z.array(z.string()),
  languages: z.array(z.string()),
  summary: z.object({
    lines: counts,
    functions: counts.optional(),
    branches: counts.optional(),
  }),
  files: z.array(
    z.object({
      file: z.string(),
      lines: counts,
      functions: counts.optional(),
      branches: counts.optional(),
      loaded: z.literal(false).optional(),
    }),
  ),
})

/** Share covered, 0..100; `undefined` when there is nothing to cover. */
export const percentOf = (part: Counts | undefined) =>
  part && part.total > 0 ? (part.covered / part.total) * 100 : undefined

/** Sums counts; `undefined` when none are given. */
export function sumCounts(parts: readonly (Counts | undefined)[]): Counts | undefined {
  const present = parts.filter((part) => part !== undefined)
  if (!present.length) return undefined
  return present.reduce((acc, part) => ({
    covered: acc.covered + part.covered,
    total: acc.total + part.total,
  }))
}
