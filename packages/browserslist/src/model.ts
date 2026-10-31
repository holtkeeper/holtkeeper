import { z } from 'zod'

/**
 * - `not-applicable`: no root lockfile resolves `caniuse-lite`.
 * - `up-to-date`: the update changed nothing.
 * - `updated`: the lockfile changed; `mergeRequest` holds the proposal unless `dryRun`.
 * - `failed`: the update command failed; `output` says why.
 */
export const browserslistStatusSchema = z.enum([
  'not-applicable',
  'up-to-date',
  'updated',
  'failed',
])

/** Browsers the project's query resolves to in one directory, before and after the update. */
export const browserTargetsSchema = z.object({
  /** Directory relative to the checkout root; `.` for the root. */
  dir: z.string(),
  /** `undefined` when the list could not be resolved, e.g. without an install. */
  before: z.array(z.string()).optional(),
  after: z.array(z.string()).optional(),
})

/** What one browserslist database update did in a repository. */
export const browserslistDataSchema = z.object({
  status: browserslistStatusSchema,
  lockfile: z.string().optional(),
  packageManager: z.string().optional(),
  /** `caniuse-lite` versions the lockfile resolved, before and after; sorted. */
  before: z.array(z.string()),
  after: z.array(z.string()),
  targets: z.array(browserTargetsSchema),
  /** Files the update changed. */
  files: z.array(z.string()),
  mergeRequest: z.object({ id: z.number(), url: z.string(), draft: z.boolean() }).optional(),
  dryRun: z.boolean(),
  /** The last lines of the update command's output. */
  output: z.string(),
  startedAt: z.string(),
})

export type BrowserslistStatus = z.output<typeof browserslistStatusSchema>
export type BrowserTargets = z.output<typeof browserTargetsSchema>
export type BrowserslistData = z.output<typeof browserslistDataSchema>

/** Browsers a directory gained and lost; empty when either side is unknown. */
export function targetChanges(targets: BrowserTargets): { added: string[]; removed: string[] } {
  if (!targets.before || !targets.after) return { added: [], removed: [] }
  const before = new Set(targets.before)
  const after = new Set(targets.after)
  return {
    added: targets.after.filter((browser) => !before.has(browser)),
    removed: targets.before.filter((browser) => !after.has(browser)),
  }
}
