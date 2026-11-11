import { defineAnalyzer, withDefaultBranchHead } from '@holtkeeper/analyzer'
import { memoryCiJobs } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { analyzeCiJobs } from './analyze.ts'
import { ciJobsAnalysis } from './report.ts'
import { addDays } from './stats.ts'
import { syncCiJobs } from './sync.ts'
import type { CiJobsData } from './types.ts'

/** Options of the `ci-jobs` analyzer, as validated from config or the panel. */
export const ciJobsOptionsSchema = z.object({
  days: z.coerce.number().int().positive().default(90),
  branch: z.string().min(1).optional(),
  recentDays: z.coerce.number().int().positive().default(14),
  changePercent: z.coerce.number().positive().default(20),
  minChangeSeconds: z.coerce.number().nonnegative().default(15),
  maxJobs: z.coerce.number().int().positive().default(50_000),
})

const syncedFromSchema = z.object({ history: z.object({ syncedFrom: z.string().optional() }) })

export type CiJobsAnalyzerOptions = z.infer<typeof ciJobsOptionsSchema>

/**
 * The `ci-jobs` analyzer (scope `repo`, needs `forge` and `history`): keeps the repository's CI
 * job attempts in the store, fetching only what is new on each run, and analyzes the window.
 * Without a store it analyzes what one full read returns. Runners keep its newest three records
 * per repository; the job history itself lives in the store. `now` exists for tests.
 */
export function createCiJobsAnalyzer(clock: { now?: () => Date } = {}) {
  return withDefaultBranchHead(
    defineAnalyzer({
      kind: 'ci-jobs',
      analysis: ciJobsAnalysis,
      scope: 'repo',
      refresh: { on: 'time', cadence: '1d' },
      needs: { forge: true, history: true },
      options: ciJobsOptionsSchema,
      keepRecords: 3,
      async run({ forge, repo, history, options, log }) {
        if (!forge) throw new Error('the ci-jobs analyzer needs a forge')
        const { maxJobs, branch, ...rest } = options
        const settings = { ...rest, ...(branch ? { branch } : {}) }
        const now = (clock.now?.() ?? new Date()).toISOString()
        const from = addDays(now, -settings.days)
        const [previous] = (await history?.analyses.list({ repo, kind: 'ci-jobs', limit: 1 })) ?? []
        const syncedFrom = syncedFromSchema.safeParse(previous?.data).data?.history.syncedFrom
        const store = history?.ciJobs ?? memoryCiJobs()
        const sync = await syncCiJobs({
          forge,
          store,
          repo,
          since: from,
          ...(syncedFrom ? { syncedFrom } : {}),
          limit: maxJobs,
          ...(log ? { log } : {}),
        })
        const [records, coverage, defaultBranch] = await Promise.all([
          store.list(repo, { from }),
          store.coverage(repo),
          (async () => (await forge.getRepository(repo.path)).defaultBranch)().catch(
            () => undefined,
          ),
        ])
        if (!history?.ciJobs) log?.('No store is configured, so history is not kept between runs.')
        for (const note of sync.notes) log?.(note)
        const analysis = analyzeCiJobs(
          records,
          { from, to: now, ...(defaultBranch ? { defaultBranch } : {}) },
          settings,
        )
        const data: CiJobsData = {
          ...analysis,
          history: {
            ...(coverage ? { oldest: coverage.oldest, newest: coverage.newest } : {}),
            jobs: coverage?.jobs ?? 0,
            ...(sync.syncedFrom ? { syncedFrom: sync.syncedFrom } : {}),
          },
        }
        return { data }
      },
    }),
  )
}

/** The `ci-jobs` analyzer with the real clock. */
export const ciJobsAnalyzer = createCiJobsAnalyzer()
