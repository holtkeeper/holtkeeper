import { z } from 'zod'

import type { PortData } from './types.ts'

const checkResult = z.object({
  name: z.string(),
  command: z.string(),
  exitCode: z.number(),
  ok: z.boolean(),
  output: z.string(),
  durationMs: z.number(),
  attempt: z.number(),
})

const agentReport = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  remainingProblems: z.array(z.string()),
})

const range = z.object({ from: z.string(), to: z.string() })

const target = z.object({
  repo: z.string(),
  webUrl: z.string().optional(),
  outcome: z.enum([
    'ported-clean',
    'ported-remapped',
    'ported-adapted',
    'already-present',
    'not-applicable',
    'failed',
    'error',
  ]),
  method: z.enum(['clean', 'remapped', 'adapted']).optional(),
  reason: z.string().optional(),
  triage: z
    .object({
      verdict: z.enum(['apply', 'already-present', 'not-applicable', 'unclear']),
      reason: z.string(),
      by: z.enum(['rules', 'agent']),
      symbols: z.array(z.string()).optional(),
    })
    .optional(),
  remapped: z.array(z.object({ from: z.string(), to: z.string() })),
  adapt: z
    .object({
      status: z.enum(['ported', 'not-applicable', 'already-present', 'failed']),
      summary: z.string(),
      changes: z.array(z.string()),
      deviations: z.array(z.string()),
    })
    .optional(),
  checks: z.array(checkResult),
  fix: z
    .object({ attempts: z.number(), report: agentReport.optional(), files: z.array(z.string()) })
    .optional(),
  changedFiles: z.array(z.string()),
  diffStat: z.object({ files: z.number(), additions: z.number(), deletions: z.number() }),
  mergeRequest: z.object({ id: z.number(), url: z.string(), draft: z.boolean() }).optional(),
  notes: z.array(z.string()),
  error: z.string().optional(),
})

/** Validates `PortData` received from analyzers. */
export const portDataSchema: z.ZodType<PortData> = z.object({
  group: z.string(),
  source: z.object({
    repo: z.string(),
    kind: z.enum(['merge-request', 'commits', 'range']),
    mergeRequest: z.number().optional(),
    commits: z.array(z.string()).optional(),
    range: range.optional(),
    title: z.string(),
    description: z.string(),
    webUrl: z.string().optional(),
    issues: z.array(z.string()),
    intent: z.string(),
    files: z.array(
      z.object({
        oldPath: z.string(),
        newPath: z.string(),
        status: z.enum(['added', 'modified', 'deleted', 'renamed']),
        binary: z.boolean().optional(),
        additions: z.number(),
        deletions: z.number(),
        diff: z.string(),
      }),
    ),
  }),
  branch: z.string(),
  dryRun: z.boolean(),
  targets: z.array(target),
  sourceComment: z.object({ posted: z.boolean(), error: z.string().optional() }).optional(),
})
