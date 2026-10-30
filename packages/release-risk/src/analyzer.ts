import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { type RiskWeights, assessRisk } from './assess.ts'
import { loadRiskInputs } from './load.ts'
import { releaseRiskAnalysis } from './report.ts'
import type { ReleaseRiskData } from './schema.ts'
import { summarizeRelease } from './summary.ts'

const weight = z.coerce.number().nonnegative().optional()

/** Options of the `release-risk` analyzer: factor weights override the defaults. */
export const releaseRiskOptions = z.object({
  weights: z
    .object({
      size: weight,
      breaking: weight,
      bundle: weight,
      vulnerabilities: weight,
      untested: weight,
      dependencies: weight,
      quality: weight,
      contributors: weight,
    })
    .optional(),
  summary: z.enum(['auto', 'changelog']).default('auto'),
})
export type ReleaseRiskOptions = z.infer<typeof releaseRiskOptions>

/**
 * The `release-risk` analyzer: assesses `context.ref` (the newest changelog's release when absent)
 * from earlier changelog, bundle, quality, depgraph and audit results of the same repository.
 * With an agent and `summary: 'auto'` the agent writes the summary.
 */
export const releaseRiskAnalyzer = defineAnalyzer<ReleaseRiskData, ReleaseRiskOptions>({
  kind: 'release-risk',
  analysis: releaseRiskAnalysis,
  scope: 'repo',
  needs: { history: true, agent: 'optional' },
  options: releaseRiskOptions,
  flags: [
    {
      flag: 'summary',
      option: 'summary',
      description: 'who writes the summary: auto (agent when configured) or changelog',
    },
  ],
  async run({ repo, ref, history, agent, dir, options, signal, log }) {
    if (!history) throw new Error('release-risk needs analysis history')
    const inputs = await loadRiskInputs(history, repo, ref)
    const weights = Object.fromEntries(
      Object.entries(options.weights ?? {}).filter(([, value]) => value !== undefined),
    ) as Partial<RiskWeights>
    const assessment = assessRisk(inputs, weights)
    const summary = await summarizeRelease(assessment, inputs.changelog?.data, {
      ...(agent && options.summary === 'auto' ? { agent } : {}),
      ...(dir ? { dir } : {}),
      ...(signal ? { signal } : {}),
      ...(log ? { log } : {}),
    })
    const data: ReleaseRiskData = { ...assessment, summary }
    const at = ref !== undefined ? inputs.changelog?.createdAt : undefined
    return { data, ...(data.ref ? { ref: data.ref } : {}), ...(at ? { at } : {}) }
  },
})
