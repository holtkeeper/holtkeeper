import { z } from 'zod'

import { computeCi } from './ci.ts'
import { computeDora } from './dora.ts'
import { computeFlow } from './flow.ts'
import { round, secondsBetween } from './stats.ts'
import type { DeliveryData, DeliveryInput, DeliveryOptions } from './types.ts'

/** Turns fetched history into `DeliveryData`. Pure and deterministic. */
export function analyzeDelivery(input: DeliveryInput, options: DeliveryOptions): DeliveryData {
  const dora = computeDora(input, options)
  const notes = [...input.notes]
  if (dora.source === 'tags')
    notes.push(
      `No deployments to "${options.productionEnvironment}" in the window: tags count as releases.`,
    )
  if (dora.source === 'pipelines')
    notes.push(
      `No deployments to "${options.productionEnvironment}" and no tags in the window: successful pipelines on ${input.defaultBranch} count as releases.`,
    )
  if (dora.source === 'none')
    notes.push('No deployments, tags or default-branch pipelines in the window.')
  return {
    window: {
      from: input.from,
      to: input.to,
      days: round(secondsBetween(input.from, input.to) / 86_400, 1),
    },
    options,
    defaultBranch: input.defaultBranch,
    counts: {
      mergeRequests: input.mergeRequests.length,
      deployments: input.deployments.length,
      tags: input.tags.length,
      pipelines: input.pipelines.length,
      jobs: input.jobs.length,
    },
    notes,
    dora,
    ci: computeCi(input),
    mergeRequests: computeFlow({ ...input, staleDays: options.staleDays }),
  }
}

const band = z.enum(['elite', 'high', 'medium', 'low'])
const distributionSchema = z.object({
  samples: z.number(),
  median: z.number().optional(),
  p90: z.number().optional(),
  p95: z.number().optional(),
})
const bucketsSchema = z.array(z.object({ label: z.string(), count: z.number() }))

/** Validates `DeliveryData`, e.g. uploads from CI. */
export const deliveryDataSchema: z.ZodType<DeliveryData> = z.object({
  window: z.object({ from: z.string(), to: z.string(), days: z.number() }),
  options: z.object({
    days: z.number(),
    productionEnvironment: z.string(),
    failureWindowHours: z.number(),
    staleDays: z.number(),
  }),
  defaultBranch: z.string(),
  counts: z.object({
    mergeRequests: z.number(),
    deployments: z.number(),
    tags: z.number(),
    pipelines: z.number(),
    jobs: z.number(),
  }),
  notes: z.array(z.string()),
  dora: z.object({
    source: z.enum(['deployments', 'tags', 'pipelines', 'none']),
    deployments: z.number(),
    failedDeployments: z.number(),
    deploymentsPerWeek: z.number(),
    leadTime: distributionSchema,
    timeToMerge: distributionSchema,
    timeToDeploy: distributionSchema,
    undeployed: z.number(),
    failedChanges: z.number(),
    changeFailureRate: z.number().optional(),
    timeToRestore: distributionSchema.extend({ incidents: z.number(), unresolved: z.number() }),
    bands: z.object({
      deploymentFrequency: band,
      leadTime: band.optional(),
      changeFailureRate: band.optional(),
      timeToRestore: band.optional(),
    }),
    weeks: z.array(
      z.object({
        week: z.string(),
        deployments: z.number(),
        failedChanges: z.number(),
        leadTimeMedian: z.number().optional(),
      }),
    ),
    failures: z.array(
      z.object({
        kind: z.enum(['deployment', 'revert', 'hotfix']),
        at: z.string(),
        fixedAfter: z.string(),
        title: z.string(),
        href: z.string().optional(),
        blamedOn: z.string().optional(),
        restoreSeconds: z.number().optional(),
      }),
    ),
  }),
  ci: z.object({
    pipelines: z.number(),
    finished: z.number(),
    successRate: z.number().optional(),
    duration: distributionSchema,
    queue: distributionSchema,
    weeks: z.array(
      z.object({
        week: z.string(),
        pipelines: z.number(),
        successRate: z.number().optional(),
        durationMedian: z.number().optional(),
        durationP95: z.number().optional(),
        queueMedian: z.number().optional(),
      }),
    ),
    jobPipelines: z.number(),
    slowestJobs: z.array(
      z.object({
        name: z.string(),
        stage: z.string(),
        runs: z.number(),
        median: z.number(),
        p95: z.number(),
      }),
    ),
    flakyJobs: z.array(
      z.object({
        name: z.string(),
        stage: z.string(),
        retriedThenPassed: z.number(),
        alternatingShas: z.number(),
        occurrences: z.number(),
      }),
    ),
    failingJobs: z.array(
      z.object({
        name: z.string(),
        stage: z.string(),
        failures: z.number(),
        runs: z.number(),
        failureRate: z.number(),
      }),
    ),
  }),
  mergeRequests: z.object({
    open: z.number(),
    drafts: z.number(),
    openByAge: bucketsSchema,
    stale: z.array(
      z.object({
        id: z.number(),
        title: z.string(),
        author: z.string(),
        webUrl: z.string(),
        draft: z.boolean(),
        labels: z.array(z.string()),
        createdAt: z.string(),
        updatedAt: z.string(),
        ageDays: z.number(),
        idleDays: z.number(),
      }),
    ),
    merged: z.number(),
    timeToMerge: distributionSchema.extend({ buckets: bucketsSchema }),
    size: distributionSchema.optional(),
  }),
})
