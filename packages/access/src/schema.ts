import { z } from 'zod'

import { actions } from './model.ts'
import { TEAM_KEY_PATTERN } from './teams.ts'

/** Validates a team key (`TEAM_KEY_PATTERN`). */
export const teamKeySchema = z
  .string()
  .regex(TEAM_KEY_PATTERN, 'use lowercase letters, digits and dashes, starting with a letter')

/** Validates a path pattern: a non-empty glob, optionally `forge:`-prefixed. */
export const pathPatternSchema = z.string().trim().min(1)

/** Validates a `Scope` from config, API input or storage. */
export const scopeSchema = z.object({
  all: z.boolean().optional(),
  teams: z.array(teamKeySchema).optional(),
  repos: z.array(pathPatternSchema).optional(),
})

/** Validates a `Grant`. */
export const grantSchema = z.object({
  scope: scopeSchema,
  actions: z.array(z.enum([...actions, '*'])).min(1),
})

/** Validates a `TeamMember`. */
export const teamMemberSchema = z.object({
  id: z.string().trim().min(1),
  role: z.enum(['maintainer', 'member']),
})
