import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { analyzeFleet } from './analyze.ts'
import { createHttpRegistry, type VersionRegistry } from './registry.ts'
import { fleetAnalysis } from './report.ts'
import { templateSpecSchema } from './templates.ts'
import type { FleetData } from './types.ts'

/** Options of the `fleet` analyzer, as config or flags give them. */
export const fleetOptionsSchema = z.object({
  libraries: z
    .union([
      z.array(z.string().min(1)),
      z.string().transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ])
    .default([]),
  minRepos: z.coerce.number().int().nonnegative().default(3),
  maxWorkspaces: z.coerce.number().int().nonnegative().default(20),
  maxLibraries: z.coerce.number().int().nonnegative().default(100),
  templates: z.array(templateSpecSchema).default([]),
})

export type FleetOptions = z.output<typeof fleetOptionsSchema>

export interface FleetAnalyzerDependencies {
  /** Called once per run; defaults to a fresh npm registry / Go proxy client, so caches last one run. */
  registry?: () => VersionRegistry
}

/** The `fleet` analyzer (group scope, forge API only); inject a registry for tests or mirrors. */
export function createFleetAnalyzer(dependencies: FleetAnalyzerDependencies = {}) {
  const registryOf = dependencies.registry ?? (() => createHttpRegistry())
  return defineAnalyzer<FleetData, FleetOptions>({
    kind: 'fleet',
    analysis: fleetAnalysis,
    scope: 'group',
    needs: { forge: true },
    options: fleetOptionsSchema,
    flags: [
      {
        flag: 'libraries',
        option: 'libraries',
        description: 'comma-separated libraries or globs to track, e.g. react,@company/*',
      },
      {
        flag: 'min-repos',
        option: 'minRepos',
        description: 'also track libraries used by this many repositories (default 3, 0 disables)',
      },
    ],
    async run({ repo, repos, forge, options, log }) {
      if (!forge) throw new Error('the fleet analyzer needs a forge')
      const data = await analyzeFleet({
        group: repo.path,
        forgeId: repo.forge,
        repos: repos ?? [],
        forge,
        registry: registryOf(),
        libraries: options.libraries,
        minRepos: options.minRepos,
        maxWorkspaces: options.maxWorkspaces,
        maxLibraries: options.maxLibraries,
        templates: options.templates,
        ...(log ? { log } : {}),
      })
      return { data }
    },
  })
}

/** The `fleet` analyzer with the default registry. */
export const fleetAnalyzer = createFleetAnalyzer()
