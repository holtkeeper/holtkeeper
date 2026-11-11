import type { CodeChange } from '@holtkeeper/changes'
import { z } from 'zod'

import { conventionModes } from './conventions.ts'
import type { StackData } from './types.ts'

const cycle = z.object({
  cycle: z.string().min(1),
  releaseDate: z.string().optional(),
  eol: z.union([z.string(), z.boolean()]),
  lts: z.union([z.string(), z.boolean()]).optional(),
  latest: z.string().optional(),
})

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

/** Validates `StackData`, e.g. uploads or records read back from the store. */
export const stackDataSchema: z.ZodType<StackData> = z.object({
  group: z.string(),
  checkedAt: z.string(),
  soonDays: z.number().int().nonnegative(),
  repos: z.array(
    z.object({
      path: z.string().min(1),
      webUrl: z.string().optional(),
      files: z.array(z.string()),
      error: z.string().optional(),
      archived: z.boolean().optional(),
    }),
  ),
  components: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(['runtime', 'package-manager', 'service', 'os', 'image', 'tool']),
      latest: z.string().optional(),
      latestLts: z.string().optional(),
      source: z.string().optional(),
      cycles: z.array(cycle).optional(),
      usages: z.array(
        z.object({
          repo: z.string().min(1),
          file: z.string().min(1),
          via: z.enum(['version-file', 'dockerfile', 'compose', 'ci', 'deploy']),
          declared: z.string(),
          version: z.string().optional(),
          variant: z.string().optional(),
          image: z.string().optional(),
        }),
      ),
    }),
  ),
  conventions: z
    .array(
      z.object({
        repo: z.string().min(1),
        file: z.string().min(1),
        mode: z.enum(conventionModes),
        status: z.enum(['matches', 'drifts', 'missing', 'error']),
        problems: z.array(z.string()),
        change: change.optional(),
      }),
    )
    .default([]),
  notes: z.array(z.object({ repo: z.string().optional(), message: z.string() })),
})
