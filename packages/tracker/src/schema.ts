import type { CodeChange } from '@holtkeeper/changes'
import { z } from 'zod'

import type { TrackerData } from './types.ts'

const position = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
})

const edit = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace'),
    file: z.string().min(1),
    range: z.object({ start: position, end: position }),
    oldText: z.string(),
    newText: z.string(),
  }),
  z.object({ kind: z.literal('create'), file: z.string().min(1), newText: z.string() }),
  z.object({ kind: z.literal('delete'), file: z.string().min(1), oldText: z.string() }),
])

const change: z.ZodType<CodeChange> = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  confidence: z.enum(['safe', 'review']),
  source: z.string(),
  target: z.object({ forge: z.string().min(1), path: z.string().min(1) }).optional(),
  edits: z.array(edit).min(1),
})

const attrs = z.record(z.string(), z.string())

const documentRef = z.object({
  provider: z.string(),
  ref: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
})

const occurrence = z.object({
  source: z.string(),
  role: z.string(),
  repo: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  document: documentRef.optional(),
  environment: z.string().optional(),
  raw: z.string().optional(),
  attrs,
})

const provenance = z.object({
  source: z.string(),
  role: z.string(),
  repo: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  document: z.string().optional(),
})

/** Validates `TrackerData`, e.g. records read back from the store. */
export const trackerDataSchema: z.ZodType<TrackerData> = z.object({
  tracker: z.object({ id: z.string().min(1), name: z.string(), label: z.string() }),
  generatedAt: z.string(),
  entities: z.array(
    z.object({
      key: z.string().min(1),
      labels: z.array(z.string()),
      attrs: z.record(
        z.string(),
        z.object({
          value: z.string(),
          from: provenance,
          values: z.array(z.object({ value: z.string(), from: provenance })).optional(),
        }),
      ),
      environments: z.record(z.string(), attrs),
      occurrences: z.array(occurrence),
    }),
  ),
  findings: z.array(
    z.object({
      id: z.string().min(1),
      rule: z.string(),
      ruleId: z.string(),
      severity: z.enum(['info', 'warning', 'error']),
      key: z.string(),
      message: z.string(),
      environment: z.string().optional(),
      occurrences: z.array(occurrence),
    }),
  ),
  sourcesRead: z.array(
    z.object({
      source: z.string(),
      kind: z.string(),
      role: z.string(),
      repo: z.string().optional(),
      document: documentRef.extend({ version: z.number().optional() }).optional(),
      files: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      extracted: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative().optional(),
    }),
  ),
  errors: z.array(
    z.object({
      source: z.string().optional(),
      output: z.string().optional(),
      repo: z.string().optional(),
      file: z.string().optional(),
      document: z.string().optional(),
      message: z.string(),
    }),
  ),
  publications: z.array(
    z.object({
      output: z.string(),
      kind: z.string(),
      provider: z.string().optional(),
      ref: z.string().optional(),
      markerId: z.string().optional(),
      format: z.enum(['storage', 'markdown', 'html', 'text']),
      content: z.string(),
      expectedVersion: z.number().optional(),
      title: z.string().optional(),
    }),
  ),
  changes: z.array(change),
})
