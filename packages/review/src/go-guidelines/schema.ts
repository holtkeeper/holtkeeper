import { z } from 'zod'

const MAJOR_MINOR = /^\d{1,2}\.\d{1,3}$/

const text = (max: number) => z.string().trim().min(1).max(max)
const snippet = z.array(z.string().max(400)).min(1).max(80)

const exampleSchema = z
  .object({ before: snippet, after: snippet })
  .refine((example) => example.before.join('').trim() && example.after.join('').trim(), {
    message: 'example snippets must not be empty',
  })

/**
 * One guideline of go-modern-guidelines, as its `guidelines.json` lists it. `modernizer`,
 * `category` and `impact` appeared after v0.1.1, so they are optional; unknown fields are dropped.
 */
export const goGuidelineSchema = z.object({
  id: z
    .string()
    .max(80)
    .regex(/^[a-z0-9_]+$/),
  since_version: z.string().regex(MAJOR_MINOR),
  modernizer: z.boolean().optional(),
  category: text(80).optional(),
  impact: z.enum(['Critical', 'High', 'Medium', 'Low']).optional(),
  guideline: text(1000),
  details: text(4000),
  examples: z.array(exampleSchema).min(1).max(10),
})

/** A guideline as validated by `goGuidelineSchema`. */
export type GoGuideline = z.infer<typeof goGuidelineSchema>

/** A whole `guidelines.json`: 1 to 500 guidelines with unique ids. */
export const goGuidelinesSchema = z
  .array(goGuidelineSchema)
  .min(1)
  .max(500)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
    message: 'guideline ids must be unique',
  })

/** Largest `guidelines.json`, in characters, that is parsed at all. */
export const GO_GUIDELINES_MAX_BYTES = 1_000_000

/** Release tags taken as upstream versions: `vMAJOR.MINOR.PATCH`, no prerelease or build part. */
export const GO_GUIDELINES_TAG = /^v\d+\.\d+\.\d+$/

/** A set of guidelines a review can use, with where it came from. */
export interface GoGuidelineSet {
  /** Upstream release tag the data comes from. */
  tag: string
  /** `bundled`: the snapshot shipped with Holtkeeper; `github`: a copy refreshed from upstream. */
  source: 'bundled' | 'github'
  /** When the copy was downloaded; absent for the bundled snapshot. */
  fetchedAt?: string
  guidelines: GoGuideline[]
}

/** A downloaded copy as the server keeps it. */
export const storedGoGuidelinesSchema = z.object({
  tag: z.string().regex(GO_GUIDELINES_TAG),
  fetchedAt: z.string(),
  /** Last time upstream was asked for its newest tag, successfully. */
  checkedAt: z.string(),
  /** ETag of the last tag listing, sent back as `If-None-Match`. */
  tagsEtag: z.string().max(200).optional(),
  count: z.number().int().positive(),
  guidelines: goGuidelinesSchema,
})

/** A downloaded copy as the server keeps it; see `storedGoGuidelinesSchema`. */
export type StoredGoGuidelines = z.infer<typeof storedGoGuidelinesSchema>

/** Parses guideline JSON text, throwing on invalid JSON, oversize input or a schema violation. */
export function parseGoGuidelines(raw: string): GoGuideline[] {
  if (raw.length > GO_GUIDELINES_MAX_BYTES)
    throw new Error(`guidelines file is larger than ${GO_GUIDELINES_MAX_BYTES} characters`)
  const parsed = goGuidelinesSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`invalid guidelines: ${issue?.path.join('.')} ${issue?.message}`.trim())
  }
  return parsed.data
}

/** The stored copy as a `GoGuidelineSet`, or `undefined` when `value` is not a valid copy. */
export function goGuidelineSetOf(value: unknown): GoGuidelineSet | undefined {
  const parsed = storedGoGuidelinesSchema.safeParse(value)
  if (!parsed.success) return undefined
  const { tag, fetchedAt, guidelines } = parsed.data
  return { tag, source: 'github', fetchedAt, guidelines }
}
