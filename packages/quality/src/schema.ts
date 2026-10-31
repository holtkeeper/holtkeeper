import type { CodeChange } from '@holtkeeper/changes'
import { z } from 'zod'

import type { QualityData } from './types.ts'

const position = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
})
const range = z.object({ start: position, end: position })

const editSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace'),
    file: z.string().min(1),
    range,
    oldText: z.string(),
    newText: z.string(),
  }),
  z.object({ kind: z.literal('create'), file: z.string().min(1), newText: z.string() }),
  z.object({ kind: z.literal('delete'), file: z.string().min(1), oldText: z.string() }),
  z.object({
    kind: z.literal('write-binary'),
    file: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    base64: z.base64().optional(),
    artifact: z.string().min(1).optional(),
    previousSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
  }),
])

/** Validates a `CodeChange` from an upload. */
export const codeChangeSchema: z.ZodType<CodeChange> = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  confidence: z.enum(['safe', 'review']),
  source: z.string(),
  target: z.object({ forge: z.string().min(1), path: z.string().min(1) }).optional(),
  edits: z.array(editSchema).min(1),
})

const counts = z.object({ covered: z.number().nonnegative(), total: z.number().nonnegative() })

/** Validates `QualityData` uploads. */
export const qualityDataSchema: z.ZodType<QualityData> = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      version: z.string().optional(),
      ok: z.boolean(),
      error: z.string().optional(),
      skipped: z.string().optional(),
      durationMs: z.number().optional(),
    }),
  ),
  issues: z.array(
    z.object({
      id: z.string(),
      tool: z.string(),
      rule: z.string(),
      category: z.enum([
        'convention',
        'tests',
        'complexity',
        'duplication',
        'lint',
        'security',
        'style',
      ]),
      severity: z.enum(['error', 'warning', 'info']),
      message: z.string(),
      file: z.string().optional(),
      range: range.optional(),
      help: z.string().optional(),
      url: z.string().optional(),
      changeId: z.string().optional(),
    }),
  ),
  tests: z.array(
    z.object({
      id: z.string(),
      file: z.string(),
      symbol: z.string(),
      kind: z.enum(['function', 'method', 'class', 'module']),
      range: range.optional(),
      reason: z.string(),
      coverage: counts.optional(),
      complexity: z.number().optional(),
      churn: z.number().optional(),
      framework: z.string().optional(),
      testFile: z.string().optional(),
      changeId: z.string().optional(),
    }),
  ),
  conventions: z.array(
    z.object({
      language: z.string(),
      kind: z.string(),
      dominant: z.string(),
      share: z.number().min(0).max(1),
      total: z.number().int().nonnegative(),
      outliers: z.number().int().nonnegative(),
      established: z.boolean().optional(),
    }),
  ),
  coverage: z.object({ lines: counts.optional(), functions: counts.optional() }).optional(),
  duplication: z
    .object({ percentage: z.number(), duplicatedLines: z.number(), totalLines: z.number() })
    .optional(),
  changes: z.array(codeChangeSchema),
})
