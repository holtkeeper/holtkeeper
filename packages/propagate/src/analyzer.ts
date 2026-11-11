import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { type PropagateSteps, runPropagation } from './pipeline.ts'
import { createHttpRegistry } from './registry.ts'
import { propagationAnalysis } from './report.ts'
import type { FixProposer, PropagationData, VersionRegistry } from './types.ts'

const list = z.union([
  z.array(z.string().min(1)),
  z.string().transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ),
])

const check = z.union([z.string().min(1), z.literal(false)]).optional()

/** Options of the `propagate` analyzer, as config or flags give them. */
export const propagateOptionsSchema = z.object({
  packages: z
    .array(
      z.object({
        name: z.string().min(1),
        version: z.string().min(1),
        ecosystem: z.enum(['npm', 'Go']).optional(),
      }),
    )
    .min(1),
  onlyRepos: list.optional(),
  checks: z
    .object({ install: check, typecheck: check, lint: check, test: check, build: check, go: check })
    .optional(),
  allowInstallScripts: z.coerce.boolean().default(false),
  fixTasks: z.coerce.boolean().default(true),
  mergeRequest: z
    .object({
      draftOnFailure: z.boolean().default(true),
      labels: z.array(z.string()).default(['holtkeeper', 'dependencies']),
      branchPrefix: z.string().min(1).default('holtkeeper/update'),
    })
    .default({
      draftOnFailure: true,
      labels: ['holtkeeper', 'dependencies'],
      branchPrefix: 'holtkeeper/update',
    }),
  sources: z.record(z.string(), z.string()).default({}),
  concurrency: z.coerce.number().int().positive().default(2),
  dryRun: z.coerce.boolean().default(false),
})

export type PropagateOptions = z.output<typeof propagateOptionsSchema>

export interface PropagateAnalyzerDependencies {
  /** Called once per run; defaults to the npm registry / Go proxy. */
  registry?: () => VersionRegistry
  steps?: PropagateSteps
  /** Proposes write tasks for repositories whose checks fail; without it they get draft merge requests. */
  fixes?: FixProposer
}

/**
 * The `propagate` analyzer (group scope). Inject `fixes` to hand failing repositories to write
 * tasks, or a registry and pipeline steps for tests.
 */
export function createPropagateAnalyzer(dependencies: PropagateAnalyzerDependencies = {}) {
  const registryOf = dependencies.registry ?? (() => createHttpRegistry())
  return defineAnalyzer<PropagationData, PropagateOptions>({
    kind: 'propagate',
    analysis: propagationAnalysis,
    scope: 'group',
    exclusive: true,
    needs: { forge: true },
    options: propagateOptionsSchema,
    flags: [
      { flag: 'only-repos', option: 'onlyRepos', description: 'comma-separated repository globs' },
      {
        flag: 'dry-run',
        option: 'dryRun',
        description: 'bump and verify without publishing',
        type: 'boolean',
      },
      {
        flag: 'allow-install-scripts',
        option: 'allowInstallScripts',
        description: 'run lifecycle scripts of installed packages',
        type: 'boolean',
      },
    ],
    async run({ repo, repos, forge, checkout, runner, options, signal, log }) {
      if (!forge) throw new Error('the propagate analyzer needs a forge')
      if (!checkout) throw new Error('the propagate analyzer needs checkouts from the runner')
      const data = await runPropagation({
        group: repo.path,
        forgeId: repo.forge,
        repos: repos ?? [],
        forge,
        checkout,
        runner,
        registry: registryOf(),
        packages: options.packages,
        ...(options.onlyRepos ? { onlyRepos: options.onlyRepos } : {}),
        ...(options.checks ? { checks: options.checks } : {}),
        allowInstallScripts: options.allowInstallScripts,
        ...(options.fixTasks && dependencies.fixes ? { fixes: dependencies.fixes } : {}),
        mergeRequest: options.mergeRequest,
        sources: options.sources,
        dryRun: options.dryRun,
        concurrency: options.concurrency,
        ...(dependencies.steps ? { steps: dependencies.steps } : {}),
        ...(signal ? { signal } : {}),
        ...(log ? { log } : {}),
      })
      return { data }
    },
  })
}

/** The `propagate` analyzer with default steps and registry, without fix tasks. */
export const propagateAnalyzer = createPropagateAnalyzer()
