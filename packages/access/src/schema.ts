import { z } from 'zod'

import { actions } from './model.ts'

/** Validates a `Scope` from config, API input or storage. */
export const scopeSchema = z.object({
  all: z.boolean().optional(),
  groups: z.array(z.string().min(1)).optional(),
  repos: z.array(z.string().min(1)).optional(),
})

/** Validates a `Grant`. */
export const grantSchema = z.object({
  scope: scopeSchema,
  actions: z.array(z.enum([...actions, '*'])).min(1),
})
