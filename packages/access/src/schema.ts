import { z } from 'zod'

import { actions } from './model.ts'

/** Validates a `GroupMatch`: a group name or a non-empty list of them. */
export const groupMatchSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])

/** Validates a `Scope` from config, API input or storage. */
export const scopeSchema = z.object({
  all: z.boolean().optional(),
  groups: z.array(groupMatchSchema).optional(),
  repos: z.array(z.string().min(1)).optional(),
})

/** Validates a `Grant`. */
export const grantSchema = z.object({
  scope: scopeSchema,
  actions: z.array(z.enum([...actions, '*'])).min(1),
})
