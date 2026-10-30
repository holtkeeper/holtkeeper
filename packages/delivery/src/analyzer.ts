import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { analyzeDelivery } from './analyze.ts'
import { collectDelivery, type CollectLimits } from './collect.ts'
import { deliveryAnalysis } from './report.ts'

/** Options of the `delivery` analyzer, as validated from config or flags. */
export const deliveryOptionsSchema = z.object({
  days: z.coerce.number().int().positive().default(90),
  productionEnvironment: z.string().min(1).default('production'),
  failureWindowHours: z.coerce.number().positive().default(24),
  staleDays: z.coerce.number().positive().default(7),
  maxPipelines: z.coerce.number().int().positive().default(300),
  jobPipelines: z.coerce.number().int().nonnegative().default(100),
})

export type DeliveryAnalyzerOptions = z.infer<typeof deliveryOptionsSchema>

/**
 * The `delivery` analyzer (scope `repo`, needs `forge`): reads merge requests, deployments, tags,
 * pipelines and jobs through the forge's optional insight reads and produces `DeliveryData`.
 * `now` and `limits` exist for tests and tuning.
 */
export function createDeliveryAnalyzer(
  settings: { now?: () => Date; limits?: Partial<CollectLimits> } = {},
) {
  return defineAnalyzer({
    kind: 'delivery',
    analysis: deliveryAnalysis,
    scope: 'repo',
    needs: { forge: true },
    options: deliveryOptionsSchema,
    flags: [
      { flag: 'days', option: 'days', description: 'window in days, ending now (default 90)' },
      {
        flag: 'environment',
        option: 'productionEnvironment',
        description: 'production environment name (default production)',
      },
      {
        flag: 'failure-window',
        option: 'failureWindowHours',
        description: 'hours after a release a failure is blamed on it (default 24)',
      },
      {
        flag: 'stale-days',
        option: 'staleDays',
        description: 'days without update before a merge request is stale (default 7)',
      },
      {
        flag: 'max-pipelines',
        option: 'maxPipelines',
        description: 'newest pipelines to fetch (default 300)',
      },
      {
        flag: 'job-pipelines',
        option: 'jobPipelines',
        description: 'pipelines whose jobs are fetched (default 100)',
      },
    ],
    async run({ forge, repo, ref, options, log }) {
      if (!forge) throw new Error('the delivery analyzer needs a forge')
      const { maxPipelines, jobPipelines, ...delivery } = options
      const input = await collectDelivery({
        forge,
        repo: repo.path,
        settings: delivery,
        now: settings.now?.() ?? new Date(),
        limits: { ...settings.limits, pipelines: maxPipelines, jobPipelines },
        ...(log ? { log } : {}),
      })
      return { data: analyzeDelivery(input, delivery), ...(ref ? { ref } : {}) }
    },
  })
}

/** The `delivery` analyzer with the real clock. */
export const deliveryAnalyzer = createDeliveryAnalyzer()
