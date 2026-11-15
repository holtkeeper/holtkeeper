import { pathPatternSchema, teamKeySchema, teamMemberSchema } from '@holtkeeper/access'
import {
  everyPattern,
  isTimeZone,
  looksLikeCron,
  teamTitleSchema,
  weekdays,
} from '@holtkeeper/core'
import type { ConfigDocumentType, TriggerDocumentData } from '@holtkeeper/store'
import { Cron } from 'croner'
import { z } from 'zod'

/** Ids of forges, schedules and teams: lowercase letters, digits and dashes. */
export const configIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'use lowercase letters, digits and dashes')

/** Ids of teams: flat keys (`TEAM_KEY_PATTERN` of `@holtkeeper/access`). */
export const teamIdSchema = teamKeySchema

const parsesAsCron = (expression: string) => {
  try {
    new Cron(expression, { paused: true }).stop()
    return true
  } catch {
    return false
  }
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')
const windowSchema = z.object({ days: z.array(z.enum(weekdays)).min(1), from: hhmm, to: hhmm })

/** Editable fields of a forge document; the webhook is managed by its own endpoint. */
export const forgeDataSchema = z.object({
  kind: z.enum(['gitlab', 'github']),
  url: z.url(),
  credentialId: z.string().min(1),
  /** Jobs read this forge's package registries with its token, through the egress proxy. Default on. */
  packages: z.boolean().optional(),
  /**
   * The egress proxy also keeps the package files jobs download from this forge's registries
   * (npm, Maven, PyPI, generic) in its download cache. Cached copies outlive the token's access.
   * Default off; needs `packages`.
   */
  cachePackages: z.boolean().optional(),
  /** Username Holtkeeper posts as on this forge; its own events and merge requests are ignored. */
  botUsername: z.string().trim().min(1).optional(),
  /** Folders of this forge Holtkeeper works on besides what teams own or consume. */
  include: z.array(pathPatternSchema).optional(),
  /** Folders left out of the fleet. */
  exclude: z.array(pathPatternSchema).optional(),
})

/** A team document: owned and consumed path patterns and members. */
export const teamDataSchema = z.object({
  title: teamTitleSchema.optional(),
  owns: z.array(pathPatternSchema).min(1),
  exclude: z.array(pathPatternSchema).default([]),
  consumes: z.array(pathPatternSchema).default([]),
  members: z.array(teamMemberSchema).default([]),
})

const targetShape = {
  teams: z.array(teamKeySchema).optional(),
  repos: z.array(pathPatternSchema).optional(),
}

export const repoTraitsDataSchema = z.object({
  pattern: z.string().min(1),
  forge: configIdSchema.optional(),
  traits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
})

export const scheduleDataSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    analyzers: z.array(z.string().min(1)).min(1),
    ...targetShape,
    options: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    cron: z
      .string()
      .refine((value) => looksLikeCron(value) && parsesAsCron(value), 'expected a cron expression')
      .optional(),
    every: z.string().regex(everyPattern, 'expected an interval such as 15m, 1h or 1d').optional(),
    timezone: z.string().refine(isTimeZone, 'expected an IANA time zone').optional(),
    windows: z
      .object({
        allow: z.array(windowSchema).optional(),
        deny: z.array(windowSchema).optional(),
        skipWeekends: z.boolean().optional(),
        skipNights: z.object({ from: hhmm, to: hhmm }).optional(),
        holidays: z
          .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'))
          .optional(),
      })
      .optional(),
    jitterMinutes: z.number().int().nonnegative().max(1440).optional(),
    spread: z.boolean().optional(),
  })
  .refine((data) => (data.cron === undefined) !== (data.every === undefined), {
    message: 'set exactly one of cron and every',
  })

const analyzerList = z.array(z.string().min(1)).min(1)

export const triggerDataSchema = z.discriminatedUnion('on', [
  z.object({
    on: z.literal('tag'),
    analyzers: analyzerList,
    ...targetShape,
  }),
  z.object({
    on: z.literal('push'),
    analyzers: analyzerList,
    branches: z.array(z.string().min(1)).min(1).optional(),
    ...targetShape,
  }),
  z.object({
    on: z.literal('mergeRequest'),
    analyzers: analyzerList,
    actions: z.array(z.enum(['open', 'update', 'reopen'])).optional(),
    draft: z.boolean().optional(),
    ...targetShape,
  }),
  z.object({
    on: z.literal('newRepo'),
    analyzers: analyzerList.optional(),
    exclude: z.array(z.string().min(1)).optional(),
    ...targetShape,
  }),
  z.object({ on: z.literal('label'), label: z.string().min(1), analyzers: analyzerList }),
  z.object({
    on: z.literal('command'),
    command: z.string().regex(/^[a-z][\w-]*$/, 'expected a lowercase command name'),
    analyzer: z.string().min(1),
    args: z.array(z.string().min(1)).optional(),
  }),
])

/** Body schemas of the panel's CRUD endpoints, by document type. */
export const documentDataSchemas = {
  forge: forgeDataSchema,
  team: teamDataSchema,
  repoTraits: repoTraitsDataSchema,
  schedule: scheduleDataSchema,
  trigger: triggerDataSchema,
} satisfies Record<ConfigDocumentType, z.ZodType>

/**
 * The fixed document id of a trigger: `tag`, `push`, `merge-request`, `new-repo`,
 * `label:<label>`, `command:<name>`.
 */
export function triggerId(data: TriggerDocumentData): string {
  if (data.on === 'tag') return 'tag'
  if (data.on === 'push') return 'push'
  if (data.on === 'mergeRequest') return 'merge-request'
  if (data.on === 'newRepo') return 'new-repo'
  if (data.on === 'label') return `label:${data.label}`
  return `command:${data.command}`
}
