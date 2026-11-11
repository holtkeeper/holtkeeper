import { z } from 'zod'

import type { CiJobsData } from './types.ts'

const spreadSchema = z.object({
  samples: z.number(),
  median: z.number().optional(),
  p90: z.number().optional(),
})

/** Validates `CiJobsData`, e.g. records uploaded from elsewhere. Unknown fields are dropped. */
export const ciJobsDataSchema: z.ZodType<CiJobsData> = z.object({
  window: z.object({ from: z.string(), to: z.string(), days: z.number() }),
  defaultBranch: z.string().optional(),
  options: z.object({
    days: z.number(),
    branch: z.string().optional(),
    recentDays: z.number(),
    changePercent: z.number(),
    minChangeSeconds: z.number(),
  }),
  history: z.object({
    oldest: z.string().optional(),
    newest: z.string().optional(),
    jobs: z.number(),
    syncedFrom: z.string().optional(),
  }),
  lastRunAt: z.string().optional(),
  pipelines: z.object({
    ref: z.string().optional(),
    count: z.number(),
    successRate: z.number().optional(),
    duration: spreadSchema,
    queue: spreadSchema,
    change: z.number().optional(),
  }),
  weeks: z.array(
    z.object({
      week: z.string(),
      pipelines: z.number(),
      median: z.number().optional(),
      p90: z.number().optional(),
    }),
  ),
  stages: z.array(z.string()),
  jobs: z.array(
    z.object({
      name: z.string(),
      stage: z.string(),
      runs: z.number(),
      pipelines: z.number(),
      failures: z.number(),
      failureRate: z.number().optional(),
      retryRate: z.number(),
      flaky: z.number(),
      allowFailure: z.boolean(),
      duration: spreadSchema,
      recentMedian: z.number().optional(),
      baselineMedian: z.number().optional(),
      change: z.number().optional(),
      trend: z.enum(['slower', 'faster', 'stable', 'new', 'idle']),
      changePoint: z
        .object({
          at: z.string(),
          before: z.number(),
          after: z.number(),
          sha: z.string().optional(),
          href: z.string().optional(),
        })
        .optional(),
      weeks: z.array(z.number().nullable()),
      last: z.object({ at: z.string(), status: z.string(), href: z.string() }),
    }),
  ),
})

/**
 * Stored data as `CiJobsData`, extra fields dropped; `undefined` for records in a shape this
 * version no longer reads, which callers treat as "no data yet".
 */
export const readCiJobs = (data: unknown): CiJobsData | undefined =>
  ciJobsDataSchema.safeParse(data).data
