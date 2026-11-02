import { scopeSchema } from '@holtkeeper/access'
import { z } from 'zod'

/** Days of the week, Monday first. */
export const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

export type Weekday = (typeof weekdays)[number]

/** The least serious tone a section reports: `info` lists everything, `bad` only problems. */
export const minToneSchema = z.enum(['info', 'warning', 'bad'])

/** When a digest goes out, in its own time zone. */
export const digestScheduleSchema = z.object({
  /** `day` runs on `days` (every day when all are listed); `week` on `days`; `month` on `dayOfMonth`. */
  every: z.enum(['day', 'week', 'month']),
  days: z.array(z.enum(weekdays)).min(1).default(['mon']),
  dayOfMonth: z.number().int().min(1).max(28).default(1),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')
    .default('10:00'),
  /** IANA zone, e.g. `Europe/Berlin`. */
  timezone: z.string().min(1).default('UTC'),
})

/** One part of a digest: the issues of an analysis kind, as serious as `minTone` or more. */
export const digestSectionSchema = z.object({
  /** Analysis kind whose latest reports are read, e.g. `licenses`, `assets`. */
  source: z.string().min(1),
  minTone: minToneSchema.default('warning'),
  /** Items shown; the rest is counted. */
  limit: z.number().int().min(1).max(50).default(8),
})

/** Where a digest is delivered. */
export const digestTargetSchema = z.discriminatedUnion('kind', [
  /** A Slack channel id (`C…`) or name; the bot must be in it. */
  z.object({ kind: z.literal('slack'), channel: z.string().min(1) }),
  /** A person's chat in the panel. */
  z.object({ kind: z.literal('panel'), userId: z.string().min(1) }),
])

/** What people edit; everything but the bookkeeping fields of `Digest`. */
export const digestInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  scope: scopeSchema,
  schedule: digestScheduleSchema,
  sections: z.array(digestSectionSchema).min(1).max(20),
  /** Only issues the previous digest did not list. */
  onlyNew: z.boolean().default(false),
  /** Send nothing when no section has items. */
  skipEmpty: z.boolean().default(true),
  targets: z.array(digestTargetSchema).max(10).default([]),
})

export type DigestInput = z.input<typeof digestInputSchema>
export type DigestSchedule = z.infer<typeof digestScheduleSchema>
export type DigestSection = z.infer<typeof digestSectionSchema>
export type DigestTarget = z.infer<typeof digestTargetSchema>

/** A saved digest. */
export interface Digest extends z.infer<typeof digestInputSchema> {
  id: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

/** Validates a stored `Digest`. */
export const digestSchema: z.ZodType<Digest> = digestInputSchema.extend({
  id: z.string().min(1),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
