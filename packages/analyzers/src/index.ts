import { type AnyAnalyzer, defineAnalyzer } from '@holtkeeper/analyzer'
import { apiSurfaceAnalyzer } from '@holtkeeper/api-surface'
import { assetsAnalyzer } from '@holtkeeper/assets'
import { branchesAnalyzer } from '@holtkeeper/branches'
import { browserslistAnalyzer } from '@holtkeeper/browserslist'
import { analyzeBundle, bundleAnalysis } from '@holtkeeper/bundles'
import { analyzeChangelog, changelogAnalysis, forgeLinks } from '@holtkeeper/changelog'
import { ciJobsAnalyzer } from '@holtkeeper/ci-jobs'
import { coverageAnalyzer } from '@holtkeeper/coverage'
import { deliveryAnalyzer } from '@holtkeeper/delivery'
import { analyzeDependencies, depgraphAnalysis } from '@holtkeeper/depgraph'
import { goSource } from '@holtkeeper/depgraph-go'
import { jsSources } from '@holtkeeper/depgraph-js'
import { fleetAnalyzer } from '@holtkeeper/fleet'
import { i18nAnalyzer } from '@holtkeeper/i18n'
import { licensesAnalyzer } from '@holtkeeper/licenses'
import { portAnalyzer } from '@holtkeeper/port'
import { propagateAnalyzer } from '@holtkeeper/propagate'
import { analyzeQuality, qualityAnalysis } from '@holtkeeper/quality'
import { conventionsCheck } from '@holtkeeper/quality-conventions'
import { deadCodeCheck } from '@holtkeeper/quality-deadcode'
import { duplicationCheck } from '@holtkeeper/quality-duplication'
import { lintCheck } from '@holtkeeper/quality-lint'
import { secretsCheck } from '@holtkeeper/quality-secrets'
import { testGapsCheck } from '@holtkeeper/quality-tests'
import { releaseRiskAnalyzer } from '@holtkeeper/release-risk'
import { renovateAnalyzer } from '@holtkeeper/renovate'
import { createReviewAnalyzer } from '@holtkeeper/review'
import { stackAnalyzer } from '@holtkeeper/stack'
import { testIdsAnalyzer } from '@holtkeeper/testids'
import { trackerAnalyzer } from '@holtkeeper/tracker'
import { usagesAnalyzer } from '@holtkeeper/usages'
import { warmupAnalyzer } from '@holtkeeper/warmup'
import { z } from 'zod'

import { auditAnalyzer } from './audit.ts'

export { auditAnalysis, auditAnalyzer } from './audit.ts'

const checkoutOf = (dir: string | undefined) => {
  if (!dir) throw new Error('this analyzer needs a checkout')
  return dir
}

export const changelogAnalyzer = defineAnalyzer({
  kind: 'changelog',
  analysis: changelogAnalysis,
  scope: 'repo',
  needs: { checkout: true },
  options: z.object({
    to: z.string().optional(),
    from: z.string().optional(),
    forge: z.enum(['gitlab', 'github']).optional(),
    webUrl: z.string().url().optional(),
  }),
  flags: [
    { flag: 'to', option: 'to', description: 'release or ref to describe (default HEAD)' },
    { flag: 'from', option: 'from', description: 'compare from this ref (default: previous tag)' },
    { flag: 'forge', option: 'forge', description: 'gitlab or github, for links' },
    { flag: 'web-url', option: 'webUrl', description: 'repository URL, for links' },
  ],
  async run({ dir, ref, options }) {
    const data = await analyzeChangelog({
      dir: checkoutOf(dir),
      to: options.to ?? ref ?? 'HEAD',
      ...(options.from ? { from: options.from } : {}),
      ...(options.forge && options.webUrl
        ? { links: forgeLinks({ kind: options.forge, webUrl: options.webUrl }) }
        : {}),
    })
    return { data, ref: data.to.name, ...(data.releasedAt ? { at: data.releasedAt } : {}) }
  },
})

export const bundleAnalyzer = defineAnalyzer({
  kind: 'bundle',
  analysis: bundleAnalysis,
  scope: 'repo',
  needs: { checkout: true },
  options: z.object({ dist: z.string().default('dist'), build: z.string().optional() }),
  flags: [
    { flag: 'dist', option: 'dist', description: 'build output directory (default dist)' },
    {
      flag: 'build',
      option: 'build',
      description: 'shell command that builds first, e.g. "bun run build"',
    },
  ],
  async run({ dir, ref, options, runner }) {
    const root = checkoutOf(dir)
    const data = await analyzeBundle({
      dist: `${root}/${options.dist}`,
      root,
      ...(options.build
        ? { build: { dir: root, command: ['sh', '-c', options.build], runner } }
        : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})

export const depgraphAnalyzer = defineAnalyzer({
  kind: 'depgraph',
  analysis: depgraphAnalysis,
  scope: 'repo',
  needs: { checkout: true },
  options: z.object({}),
  async run({ dir, ref, runner }) {
    const data = await analyzeDependencies({
      dir: checkoutOf(dir),
      sources: [...jsSources(), goSource({ runner })],
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})

export const qualityAnalyzer = defineAnalyzer({
  kind: 'quality',
  analysis: qualityAnalysis,
  scope: 'repo',
  needs: { checkout: true, agent: 'optional' },
  options: z.object({
    examples: z.coerce.number().int().nonnegative().default(3),
    coverage: z.enum(['run', 'skip']).default('run'),
  }),
  flags: [
    {
      flag: 'examples',
      option: 'examples',
      description: 'example tests the agent writes (default 3)',
    },
    {
      flag: 'coverage',
      option: 'coverage',
      description: 'run tests for coverage: run (default) or skip',
    },
  ],
  async run({ dir, ref, runner, agent, options, signal }) {
    const data = await analyzeQuality({
      dir: checkoutOf(dir),
      runner,
      ...(agent ? { agent } : {}),
      ...(signal ? { signal } : {}),
      checks: [
        conventionsCheck(),
        lintCheck(),
        duplicationCheck(),
        deadCodeCheck(),
        secretsCheck(),
        ...(options.coverage === 'run' ? [testGapsCheck({ examples: options.examples })] : []),
      ],
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})

/** Quality checks the review analyzer may run on changed lines. */
export const reviewChecks = () => ({
  lint: lintCheck(),
  secrets: secretsCheck(),
  conventions: conventionsCheck(),
})

/** Every analyzer Holtkeeper ships, in the order help texts list them. */
export const builtinAnalyzers: AnyAnalyzer[] = [
  changelogAnalyzer,
  bundleAnalyzer,
  depgraphAnalyzer,
  qualityAnalyzer,
  coverageAnalyzer,
  testIdsAnalyzer,
  apiSurfaceAnalyzer,
  usagesAnalyzer,
  licensesAnalyzer,
  releaseRiskAnalyzer,
  fleetAnalyzer,
  stackAnalyzer,
  assetsAnalyzer,
  deliveryAnalyzer,
  branchesAnalyzer,
  ciJobsAnalyzer,
  i18nAnalyzer,
  propagateAnalyzer,
  portAnalyzer,
  createReviewAnalyzer({ checks: reviewChecks() }),
  trackerAnalyzer,
  warmupAnalyzer,
  browserslistAnalyzer,
  renovateAnalyzer,
  auditAnalyzer,
]
