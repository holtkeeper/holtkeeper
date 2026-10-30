import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { analyzeBranches } from './analyze.ts'
import type { BranchesData } from './model.ts'
import { branchesAnalysis } from './report.ts'

/** Options of the `branches` analyzer. */
export const branchesOptionsSchema = z.object({
  /** Days without commits after which a branch is stale. */
  staleDays: z.coerce.number().int().positive().default(90),
  /** Glob patterns of branch names never reported, e.g. `release/*`; a comma-separated string works too. */
  ignore: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : value,
    z.array(z.string().min(1)).default([]),
  ),
  /** Judge protected branches too. */
  includeProtected: z.boolean().default(false),
})

export type BranchesOptions = z.output<typeof branchesOptionsSchema>

/**
 * The `branches` analyzer (scope `repo`, needs `forge`): reads branches and merge requests through
 * the forge and reports branches that are merged, closed unmerged or stale. It never deletes
 * anything. `now` exists for tests.
 */
export function createBranchesAnalyzer(settings: { now?: () => Date } = {}) {
  return defineAnalyzer<BranchesData, BranchesOptions>({
    kind: 'branches',
    analysis: branchesAnalysis,
    scope: 'repo',
    needs: { forge: true },
    options: branchesOptionsSchema,
    flags: [
      {
        flag: 'stale-days',
        option: 'staleDays',
        description: 'days without commits before a branch is stale (default 90)',
      },
      {
        flag: 'ignore',
        option: 'ignore',
        description: 'comma-separated globs of branches to skip',
      },
      {
        flag: 'include-protected',
        option: 'includeProtected',
        description: 'judge protected branches too',
        type: 'boolean',
      },
    ],
    async run({ forge, repo, ref, options, log }) {
      if (!forge) throw new Error('the branches analyzer needs a forge')
      const data = await analyzeBranches({
        forge,
        repo: repo.path,
        now: settings.now?.() ?? new Date(),
        ...options,
        ...(log ? { log } : {}),
      })
      return { data, ...(ref ? { ref } : {}) }
    },
  })
}

/** The `branches` analyzer with the real clock. */
export const branchesAnalyzer = createBranchesAnalyzer()
