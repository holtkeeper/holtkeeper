import { z } from 'zod'

import type { PropagationData } from './types.ts'

const ecosystem = z.enum(['npm', 'Go'])

const usage = z.object({
  package: z.string(),
  ecosystem,
  manifest: z.string(),
  path: z.array(z.string()),
  kind: z.enum(['prod', 'dev', 'peer', 'optional', 'override', 'resolution', 'catalog', 'go']),
  declared: z.string(),
  current: z.string().optional(),
  next: z.string().optional(),
  note: z.string().optional(),
})

const check = z.object({
  name: z.string(),
  command: z.string(),
  exitCode: z.number(),
  ok: z.boolean(),
  output: z.string(),
  durationMs: z.number(),
  attempt: z.number(),
})

const repoOutcome = z.object({
  repo: z.string(),
  webUrl: z.string().optional(),
  status: z.enum(['unchanged', 'skipped', 'updated', 'fixed', 'failed', 'error']),
  usages: z.array(usage),
  bumps: z.array(
    z.object({ package: z.string(), from: z.string(), to: z.string(), manifest: z.string() }),
  ),
  checks: z.array(check),
  attempts: z.number(),
  agent: z
    .object({
      summary: z.string(),
      changes: z.array(z.string()),
      remainingProblems: z.array(z.string()),
    })
    .optional(),
  changedFiles: z.array(z.string()),
  fixedFiles: z.array(z.string()),
  mergeRequest: z.object({ id: z.number(), url: z.string(), draft: z.boolean() }).optional(),
  notes: z.array(z.string()),
  error: z.string().optional(),
})

/** Validates `PropagationData`, e.g. records uploaded from CI. */
export const propagationDataSchema: z.ZodType<PropagationData> = z.object({
  group: z.string(),
  packages: z.array(
    z.object({ name: z.string(), ecosystem, requested: z.string(), version: z.string() }),
  ),
  dryRun: z.boolean(),
  repos: z.array(repoOutcome),
  releaseNotes: z.array(
    z.object({
      package: z.string(),
      from: z.string().optional(),
      to: z.string(),
      source: z.string(),
      text: z.string(),
    }),
  ),
})
