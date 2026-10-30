import { z } from 'zod'

import type { CiJobsData } from './types.ts'

const spreadSchema = z.object({
  samples: z.number(),
  p25: z.number().optional(),
  median: z.number().optional(),
  p75: z.number().optional(),
  p95: z.number().optional(),
  max: z.number().optional(),
})

const quantiles = {
  p25: z.number().optional(),
  median: z.number().optional(),
  p75: z.number().optional(),
  p95: z.number().optional(),
}

/** Validates `CiJobsData`, e.g. records uploaded from elsewhere. */
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
  sync: z.object({
    mode: z.enum(['full', 'incremental', 'none']),
    after: z.string().optional(),
    fetched: z.number(),
    stored: z.number(),
  }),
  notes: z.array(z.string()),
  totals: z.object({
    runs: z.number(),
    pipelines: z.number(),
    jobs: z.number(),
    failures: z.number(),
    failureRate: z.number().optional(),
    retryRate: z.number(),
    flakyJobs: z.number(),
    slowerJobs: z.number(),
    fasterJobs: z.number(),
    computeSeconds: z.number(),
    wallTime: spreadSchema,
    queue: spreadSchema,
  }),
  weeks: z.array(
    z.object({
      week: z.string(),
      pipelines: z.number(),
      runs: z.number(),
      failures: z.number(),
      failureRate: z.number().optional(),
      ...quantiles,
      queueMedian: z.number().optional(),
      computeSeconds: z.number(),
    }),
  ),
  refGroups: z.array(
    z.object({
      group: z.enum(['main', 'develop', 'release', 'feature', 'merge-request', 'tag']),
      label: z.string(),
      hasDefault: z.boolean(),
      pipelines: z.number(),
      refs: z.number(),
      failureRate: z.number().optional(),
      duration: spreadSchema,
      recentMedian: z.number().optional(),
      baselineMedian: z.number().optional(),
      change: z.number().optional(),
      weeks: z.array(
        z.object({
          week: z.string(),
          pipelines: z.number(),
          median: z.number().optional(),
          p95: z.number().optional(),
        }),
      ),
      topRefs: z.array(
        z.object({ ref: z.string(), pipelines: z.number(), median: z.number().optional() }),
      ),
    }),
  ),
  stages: z.array(z.object({ stage: z.string(), computeSeconds: z.number() })),
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
      queueMedian: z.number().optional(),
      computeSeconds: z.number(),
      computeShare: z.number(),
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
          ref: z.string().optional(),
          href: z.string().optional(),
        })
        .optional(),
      weeks: z.array(
        z.object({
          week: z.string(),
          runs: z.number(),
          ...quantiles,
          failureRate: z.number().optional(),
        }),
      ),
      last: z.object({
        at: z.string(),
        status: z.string(),
        href: z.string(),
        ref: z.string().optional(),
      }),
    }),
  ),
})
