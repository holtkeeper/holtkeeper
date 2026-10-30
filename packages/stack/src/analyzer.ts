import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { analyzeStack } from './analyze.ts'
import { stackAnalysis } from './report.ts'
import { createHttpSources, type VersionSources } from './sources.ts'
import type { StackData } from './types.ts'

const list = z
  .union([
    z.array(z.string().min(1)),
    z.string().transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ])
  .default([])

/** Options of the `stack` analyzer, as config or flags give them. */
export const stackOptionsSchema = z.object({
  ignore: list,
  soonDays: z.coerce.number().int().nonnegative().default(180),
  maxFiles: z.coerce.number().int().positive().default(50),
  lookups: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
    .default(true),
})

export type StackOptions = z.output<typeof stackOptionsSchema>

export interface StackAnalyzerDependencies {
  /** Called once per run; defaults to fresh HTTP sources, so caches last one run. */
  sources?: () => VersionSources
}

/** The `stack` analyzer (group scope, forge API only); inject sources for tests or mirrors. */
export function createStackAnalyzer(dependencies: StackAnalyzerDependencies = {}) {
  const sourcesOf = dependencies.sources ?? (() => createHttpSources())
  return defineAnalyzer<StackData, StackOptions>({
    kind: 'stack',
    analysis: stackAnalysis,
    scope: 'group',
    needs: { forge: true },
    options: stackOptionsSchema,
    flags: [
      {
        flag: 'ignore',
        option: 'ignore',
        description: 'comma-separated components to leave out, e.g. image:registry.example.com/*',
      },
      {
        flag: 'soon-days',
        option: 'soonDays',
        description: 'days before an end of life that count as soon (default 180)',
      },
      {
        flag: 'lookups',
        option: 'lookups',
        description: 'look up latest versions and release lines online (default true)',
        type: 'boolean',
      },
    ],
    async run({ repo, repos, forge, options, log }) {
      if (!forge) throw new Error('the stack analyzer needs a forge')
      const data = await analyzeStack({
        group: repo.path,
        repos: repos ?? [],
        forge,
        ...(options.lookups ? { sources: sourcesOf() } : {}),
        ignore: options.ignore,
        soonDays: options.soonDays,
        maxFiles: options.maxFiles,
        ...(log ? { log } : {}),
      })
      return { data }
    },
  })
}

/** The `stack` analyzer with the default sources. */
export const stackAnalyzer = createStackAnalyzer()
