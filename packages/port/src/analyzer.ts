import type { Toolset } from '@holtkeeper/agent'
import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { type PortSteps, runPort } from './pipeline.ts'
import { portAnalysis } from './report.ts'
import { parseSourceSpec, sourceKind } from './source.ts'
import type { PortData } from './types.ts'

const list = z.union([
  z.array(z.string().min(1)),
  z.string().transform((value) =>
    value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
])

const check = z.union([z.string().min(1), z.literal(false)]).optional()

const sourceObject = z.object({
  repo: z.string().min(1),
  mergeRequest: z.coerce.number().int().positive().optional(),
  commits: z.array(z.string().min(4)).min(1).optional(),
  range: z.object({ from: z.string().min(1), to: z.string().min(1) }).optional(),
})

const source = z
  .union([
    sourceObject,
    z
      .string()
      .min(1)
      .transform((text) => parseSourceSpec(text)),
  ])
  .superRefine((value, ctx) => {
    try {
      sourceKind(value)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

/** Options of the `port` analyzer, as config, flags or the command form give them. */
export const portOptionsSchema = z.object({
  source,
  targets: list.optional(),
  checks: z
    .object({ install: check, typecheck: check, lint: check, test: check, build: check, go: check })
    .optional(),
  fix: z
    .object({
      enabled: z.boolean().optional(),
      maxAttempts: z.coerce.number().int().nonnegative().default(3),
      maxTurns: z.coerce.number().int().positive().default(40),
      timeoutMinutes: z.coerce.number().positive().optional(),
    })
    .default({ maxAttempts: 3, maxTurns: 40 }),
  mergeRequest: z
    .object({
      branchPrefix: z.string().min(1).default('holtkeeper/port'),
      labels: z.array(z.string()).default(['holtkeeper', 'port']),
      draftOnFailure: z.boolean().default(true),
    })
    .default({
      branchPrefix: 'holtkeeper/port',
      labels: ['holtkeeper', 'port'],
      draftOnFailure: true,
    }),
  commentOnSource: z.coerce.boolean().default(true),
  concurrency: z.coerce.number().int().positive().default(2),
  dryRun: z.coerce.boolean().default(false),
})

export type PortOptions = z.output<typeof portOptionsSchema>

/** What `createPortAnalyzer` can inject. */
export interface PortAnalyzerDependencies {
  steps?: PortSteps
  /** Code tools for the agent (e.g. `@holtkeeper/agent-tools`), mounted for triage and adaptation. */
  toolsets?: Toolset[]
}

/** The `port` analyzer (group scope); inject steps or agent code tools. */
export function createPortAnalyzer(dependencies: PortAnalyzerDependencies = {}) {
  return defineAnalyzer<PortData, PortOptions>({
    kind: 'port',
    analysis: portAnalysis,
    scope: 'group',
    exclusive: true,
    needs: { forge: true, agent: 'optional' },
    options: portOptionsSchema,
    flags: [
      {
        flag: 'source',
        option: 'source',
        description: 'repo!<mr>, repo@<sha>[,<sha>] or repo@<from>..<to>',
      },
      {
        flag: 'targets',
        option: 'targets',
        description:
          'repository globs or group names, comma-separated (also the positional argument)',
      },
      {
        flag: 'dry-run',
        option: 'dryRun',
        description: 'port and verify without publishing',
        type: 'boolean',
      },
    ],
    async run({ repo, repos, forge, checkout, runner, agent, options, signal, log }) {
      if (!forge) throw new Error('the port analyzer needs a forge')
      if (!checkout) throw new Error('the port analyzer needs checkouts from the runner')
      const data = await runPort({
        group: repo.path,
        forgeId: repo.forge,
        repos: repos ?? [],
        forge,
        checkout,
        runner,
        ...(agent ? { agent } : {}),
        ...(dependencies.toolsets ? { toolsets: dependencies.toolsets } : {}),
        source: options.source,
        ...(options.targets ? { targets: options.targets } : {}),
        ...(options.checks ? { checks: options.checks } : {}),
        fix: options.fix,
        mergeRequest: options.mergeRequest,
        commentOnSource: options.commentOnSource,
        concurrency: options.concurrency,
        dryRun: options.dryRun,
        ...(dependencies.steps ? { steps: dependencies.steps } : {}),
        ...(signal ? { signal } : {}),
        ...(log ? { log } : {}),
      })
      return { data }
    },
  })
}

/** The `port` analyzer with default steps. */
export const portAnalyzer = createPortAnalyzer()
