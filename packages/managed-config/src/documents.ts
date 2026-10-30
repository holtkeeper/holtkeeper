import { everyPattern, isTimeZone, looksLikeCron, weekdays } from '@holtkeeper/core'
import type { ConfigDocumentType, TriggerDocumentData } from '@holtkeeper/store'
import { Cron } from 'croner'
import { z } from 'zod'

/** Ids of forges, groups and schedules follow the file config's rule. */
export const configIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'use lowercase letters, digits and dashes')

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
})

export const groupDataSchema = z.object({
  forge: configIdSchema,
  include: z.array(z.string().min(1)).min(1),
  exclude: z.array(z.string().min(1)).default([]),
})

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
    groups: z.array(z.string()).optional(),
    repos: z.array(z.string().regex(/^[^:]+:.+$/, 'expected forge:path')).optional(),
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
    groups: z.array(z.string()).optional(),
  }),
  z.object({
    on: z.literal('mergeRequest'),
    analyzers: analyzerList,
    actions: z.array(z.enum(['open', 'update', 'reopen'])).optional(),
    draft: z.boolean().optional(),
    groups: z.array(z.string()).optional(),
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
  group: groupDataSchema,
  repoTraits: repoTraitsDataSchema,
  schedule: scheduleDataSchema,
  trigger: triggerDataSchema,
} satisfies Record<ConfigDocumentType, z.ZodType>

/** The fixed document id of a trigger: `tag`, `merge-request`, `label:<label>`, `command:<name>`. */
export function triggerId(data: TriggerDocumentData): string {
  if (data.on === 'tag') return 'tag'
  if (data.on === 'mergeRequest') return 'merge-request'
  if (data.on === 'label') return `label:${data.label}`
  return `command:${data.command}`
}
