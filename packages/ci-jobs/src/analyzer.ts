import { defineAnalyzer } from '@holtkeeper/analyzer'
import { memoryCiJobs } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { analyzeCiJobs } from './analyze.ts'
import { ciJobsAnalysis } from './report.ts'
import { ciJobsDataSchema } from './schema.ts'
import { addDays } from './stats.ts'
import { syncCiJobs } from './sync.ts'
import type { CiJobsData } from './types.ts'

/** Options of the `ci-jobs` analyzer, as validated from config or flags. */
export const ciJobsOptionsSchema = z.object({
  days: z.coerce.number().int().positive().default(90),
  branch: z.string().min(1).optional(),
  recentDays: z.coerce.number().int().positive().default(14),
  changePercent: z.coerce.number().positive().default(20),
  minChangeSeconds: z.coerce.number().nonnegative().default(15),
  maxJobs: z.coerce.number().int().positive().default(50_000),
})

export type CiJobsAnalyzerOptions = z.infer<typeof ciJobsOptionsSchema>

/**
 * The `ci-jobs` analyzer (scope `repo`, needs `forge` and `history`): keeps the repository's CI
 * job attempts in the store, fetching only what is new on each run, and analyzes the window.
 * Without a store it analyzes what one full read returns. `now` exists for tests.
 */
export function createCiJobsAnalyzer(clock: { now?: () => Date } = {}) {
  return defineAnalyzer({
    kind: 'ci-jobs',
    analysis: ciJobsAnalysis,
    scope: 'repo',
    needs: { forge: true, history: true },
    options: ciJobsOptionsSchema,
    flags: [
      { flag: 'days', option: 'days', description: 'window in days, ending now (default 90)' },
      { flag: 'branch', option: 'branch', description: 'only pipelines of this branch or tag' },
      {
        flag: 'recent-days',
        option: 'recentDays',
        description: 'recent days compared with the rest of the window (default 14)',
      },
      {
        flag: 'change-percent',
        option: 'changePercent',
        description: 'median change in percent that marks a job slower or faster (default 20)',
      },
      {
        flag: 'min-change',
        option: 'minChangeSeconds',
        description: 'smallest median change in seconds that counts (default 15)',
      },
      {
        flag: 'max-jobs',
        option: 'maxJobs',
        description: 'job attempts one sync reads at most (default 50000)',
      },
    ],
    presets: [
      {
        id: 'default-branch-quarter',
        label: 'Main branch, 90 days',
        description: 'Only pipelines of main, where durations are comparable run to run.',
        options: { branch: 'main', days: 90 },
      },
      {
        id: 'half-year',
        label: 'Half a year',
        description: 'Long trends across every branch.',
        options: { days: 180, recentDays: 28 },
      },
    ],
    async run({ forge, repo, history, options, log }) {
      if (!forge) throw new Error('the ci-jobs analyzer needs a forge')
      const { maxJobs, branch, ...rest } = options
      const settings = { ...rest, ...(branch ? { branch } : {}) }
      const now = (clock.now?.() ?? new Date()).toISOString()
      const from = addDays(now, -settings.days)
      const [previous] = (await history?.analyses.list({ repo, kind: 'ci-jobs', limit: 1 })) ?? []
      const syncedFrom = ciJobsDataSchema.safeParse(previous?.data).data?.history.syncedFrom
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
        (async () => (await forge.getRepository(repo.path)).defaultBranch)().catch(() => undefined),
      ])
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
        sync: {
          mode: sync.mode,
          ...(sync.after ? { after: sync.after } : {}),
          fetched: sync.fetched,
          stored: sync.stored,
        },
        notes: [
          ...(history?.ciJobs
            ? []
            : ['No store is configured, so history is not kept between runs.']),
          ...sync.notes,
        ],
      }
      return { data }
    },
  })
}

/** The `ci-jobs` analyzer with the real clock. */
export const ciJobsAnalyzer = createCiJobsAnalyzer()
