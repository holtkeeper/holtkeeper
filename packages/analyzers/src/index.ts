import { type AnyAnalyzer, defineAnalyzer, dependencyPaths } from '@holtkeeper/analyzer'
import { apiSurfaceAnalyzer } from '@holtkeeper/api-surface'
import { assetsAnalyzer } from '@holtkeeper/assets'
import { branchesAnalyzer } from '@holtkeeper/branches'
import { browserslistAnalyzer } from '@holtkeeper/browserslist'
import { ciJobsAnalyzer } from '@holtkeeper/ci-jobs'
import { coverageAnalyzer } from '@holtkeeper/coverage'
import { analyzeDependencies, depgraphAnalysis } from '@holtkeeper/depgraph'
import { goSource } from '@holtkeeper/depgraph-go'
import { jsSources } from '@holtkeeper/depgraph-js'
import { createGuideAnalyzer } from '@holtkeeper/guide-generator'
import { i18nAnalyzer } from '@holtkeeper/i18n'
import { createKnowledgeBootstrapAnalyzer } from '@holtkeeper/knowledge-bootstrap'
import { licensesAnalyzer } from '@holtkeeper/licenses'
import { propagateAnalyzer } from '@holtkeeper/propagate'
import { secretsCheck } from '@holtkeeper/quality-secrets'
import { renovateAnalyzer } from '@holtkeeper/renovate'
import { createReviewAnalyzer } from '@holtkeeper/review'
import { stackAnalyzer } from '@holtkeeper/stack'
import { type TestIdOverrides, testIdsAnalyzer, testIdsCheck } from '@holtkeeper/testids'
import { trackerAnalyzer } from '@holtkeeper/tracker'
import { usagesAnalyzer } from '@holtkeeper/usages'
import { writeTaskAnalyzer } from '@holtkeeper/write-task'
import { z } from 'zod'

import { auditAnalyzer } from './audit.ts'
import { bundleAnalyzer } from './bundle.ts'

export {
  type AuditFindingMetric,
  type AuditMetrics,
  auditAnalysis,
  auditAnalyzer,
  auditFindingKey,
} from './audit.ts'
export { bundleAnalyzer } from './bundle.ts'

const checkoutOf = (dir: string | undefined) => {
  if (!dir) throw new Error('this analyzer needs a checkout')
  return dir
}

export const depgraphAnalyzer = defineAnalyzer({
  kind: 'depgraph',
  analysis: depgraphAnalysis,
  scope: 'repo',
  refresh: { on: 'change', minInterval: '30m', paths: dependencyPaths },
  needs: { checkout: true },
  options: z.object({}),
  async run({ dir, ref, runner, log }) {
    const data = await analyzeDependencies({
      dir: checkoutOf(dir),
      sources: [...jsSources(), goSource({ runner })],
      ...(log ? { log } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})

/**
 * Quality checks the review analyzer may run on changed lines; `testids` takes the team's
 * overrides of the repository under review.
 */
export const reviewChecks = (options: { testids?: TestIdOverrides } = {}) => ({
  secrets: secretsCheck(),
  testids: testIdsCheck(options.testids ? { overrides: options.testids } : {}),
})

/** Every analyzer Holtkeeper ships, in the order help texts list them. */
export const builtinAnalyzers: AnyAnalyzer[] = [
  bundleAnalyzer,
  depgraphAnalyzer,
  coverageAnalyzer,
  testIdsAnalyzer,
  apiSurfaceAnalyzer,
  usagesAnalyzer,
  licensesAnalyzer,
  stackAnalyzer,
  assetsAnalyzer,
  branchesAnalyzer,
  ciJobsAnalyzer,
  i18nAnalyzer,
  propagateAnalyzer,
  createReviewAnalyzer({ checks: reviewChecks() }),
  createGuideAnalyzer(),
  createKnowledgeBootstrapAnalyzer(),
  trackerAnalyzer,
  browserslistAnalyzer,
  renovateAnalyzer,
  auditAnalyzer,
  writeTaskAnalyzer,
]
