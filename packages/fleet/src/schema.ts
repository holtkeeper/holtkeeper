import type { CodeChange } from '@holtkeeper/changes'
import { z } from 'zod'

import type { FleetData } from './types.ts'

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

/** Validates `FleetData`, e.g. uploads or records read back from the store. */
export const fleetDataSchema: z.ZodType<FleetData> = z.object({
  group: z.string(),
  repos: z.array(
    z.object({
      path: z.string().min(1),
      webUrl: z.string().optional(),
      manifests: z.array(z.string()),
      error: z.string().optional(),
      archived: z.boolean().optional(),
    }),
  ),
  libraries: z.array(
    z.object({
      ecosystem: z.enum(['npm', 'Go']),
      name: z.string().min(1),
      latest: z.string().optional(),
      definedIn: z.string().optional(),
      reason: z.enum(['option', 'auto']),
      usages: z.array(
        z.object({
          repo: z.string().min(1),
          manifest: z.string().min(1),
          declared: z.string(),
          resolved: z.string().optional(),
          version: z.string().optional(),
          kind: z.enum(['prod', 'dev', 'peer', 'optional', 'indirect']),
        }),
      ),
    }),
  ),
  templates: z.array(
    z.object({
      repo: z.string().min(1),
      file: z.string().min(1),
      mode: z.enum(['exact', 'json-subset', 'yaml-subset', 'lines-present']),
      status: z.enum(['identical', 'drifted', 'missing', 'error']),
      problems: z.array(z.string()),
      change: change.optional(),
    }),
  ),
  notes: z.array(z.object({ repo: z.string().optional(), message: z.string() })),
})
