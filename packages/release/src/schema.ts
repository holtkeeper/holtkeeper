import { z } from 'zod'

import { releaseEventKinds } from './settings.ts'

/** Validates a stored or submitted `Acceptance`. */
export const acceptanceSchema = z.object({
  sha: z.string(),
  by: z.string(),
  at: z.string(),
  via: z.enum(['manual', 'label', 'merge']),
  note: z.string().optional(),
})

/** Validates a stored or submitted `ReleaseEdits`; unknown fields are dropped. */
export const releaseEditsSchema = z.object({
  version: z.string().trim().min(1).optional(),
  excluded: z.array(z.string()).optional(),
  included: z.array(z.string()).optional(),
  texts: z.record(z.string(), z.string()).optional(),
  summary: z
    .object({
      markdown: z.string(),
      source: z.enum(['agent', 'changelog', 'person']),
      at: z.string(),
    })
    .optional(),
  title: z.string().trim().min(1).optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

/** Validates a stored `ReleaseEvent`. */
export const releaseEventSchema = z.object({
  kind: z.enum(releaseEventKinds),
  repo: z.object({ forge: z.string(), path: z.string() }),
  at: z.string(),
  actor: z.string(),
  version: z.string().optional(),
  tag: z.string().optional(),
  environment: z.string().optional(),
  url: z.string().optional(),
  detail: z.string().optional(),
})

/** `value` read with `schema`, or `undefined` when it is missing or no longer fits. */
export const readStored = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
