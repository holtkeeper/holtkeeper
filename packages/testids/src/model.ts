import { z } from 'zod'

/** An interactive element without a test id. */
export interface MissingElement {
  line: number
  /** As written, e.g. `Button`, `S.Submit`, `button`. */
  tag: string
  /** The native tag it renders, when it differs from `tag` and is known. */
  as?: string
  /** Why it counts as interactive, e.g. `button`, `click handler`, `role=tab`. */
  reason: string
  /** `unverified`: it spreads props that may carry a test id. */
  status: 'missing' | 'unverified'
}

/** Interactive elements of one template file. */
export interface TestIdFile {
  /** Relative to the checkout, `/`-separated. */
  file: string
  /** Template source that read it: `jsx`, `vue`, `svelte`, `html`. */
  source: string
  /** Interactive elements found. */
  total: number
  /** Elements with a test id attribute. */
  tagged: number
  /** Elements without one that spread props, so may get one at runtime. */
  unverified: number
  /** Elements without a test id, missing first; capped, counts stay exact. */
  elements: MissingElement[]
}

/** Everything a `testids` analysis found; serializable, stored as analysis data. */
export interface TestIdsData {
  /** Attribute names that counted as a test id. */
  attributes: string[]
  /** Files with at least one interactive element. */
  files: TestIdFile[]
  /** How often each configured attribute was used, for spotting mixed conventions. */
  usage: Record<string, number>
}

/** Validates `TestIdsData` uploads. */
export const testIdsDataSchema: z.ZodType<TestIdsData> = z.object({
  attributes: z.array(z.string()),
  files: z.array(
    z.object({
      file: z.string(),
      source: z.string(),
      total: z.number(),
      tagged: z.number(),
      unverified: z.number(),
      elements: z.array(
        z.object({
          line: z.number(),
          tag: z.string(),
          as: z.string().optional(),
          reason: z.string(),
          status: z.enum(['missing', 'unverified']),
        }),
      ),
    }),
  ),
  usage: z.record(z.string(), z.number()),
})

/** Totals over files. */
export function testIdTotals(files: readonly TestIdFile[]) {
  const total = files.reduce((sum, file) => sum + file.total, 0)
  const tagged = files.reduce((sum, file) => sum + file.tagged, 0)
  const unverified = files.reduce((sum, file) => sum + file.unverified, 0)
  return { total, tagged, unverified, missing: total - tagged - unverified }
}

/** Share of interactive elements with a test id, 0..100; `undefined` without elements. */
export const taggedPercent = (counts: { total: number; tagged: number }) =>
  counts.total > 0 ? (counts.tagged / counts.total) * 100 : undefined
