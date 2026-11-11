import type { Toolset } from '@holtkeeper/agent'
import { defineTool } from '@holtkeeper/agent-tools'
import type { RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import type { CheckResult, WriteTaskOptions } from './schema.ts'
import type { CheckSpec } from './workspace.ts'

/** A repository related to the task's own, and how. */
export interface RelatedRepo {
  /** `forge:path`. */
  repo: string
  /** E.g. `same group shapes`, `same family widgets`, `in this task`. */
  relation: string
}

/** What the `repos` toolset asks the server; without it those tools answer that nothing is known. */
export interface WriteTaskLinks {
  /** Repositories sharing a group or family with `repo`, and the other targets of the task's group. */
  related?(repo: RepoRef, options: WriteTaskOptions): Promise<RelatedRepo[]>
  /**
   * Asks people to add `target` to the task's group; answers what happens next. Nothing changes
   * until a person approves.
   */
  requestRepository?(input: {
    repo: RepoRef
    options: WriteTaskOptions
    target: string
    reason: string
  }): Promise<string>
}

/** What the agent asked the merge request to say, through `open_merge_request`. */
export interface MergeRequestRequest {
  title: string
  description?: string
  draft?: boolean
}

const MAX_OUTPUT = 2000

const describeChecks = (results: readonly CheckResult[]) =>
  results.length === 0
    ? 'No checks are configured for this repository.'
    : results
        .map((result) =>
          result.ok
            ? `${result.name} (\`${result.command}\`): passed`
            : `${result.name} (\`${result.command}\`): failed with exit ${result.exitCode}\n${result.output.slice(-MAX_OUTPUT)}`,
        )
        .join('\n\n')

/**
 * The `repos` toolset of one write task: `list_related_repos` and `request_repository` (through
 * `links`), `run_checks` over the task's detected checks, and `open_merge_request`, which only
 * records the title and description for the merge request Holtkeeper opens from this workspace
 * once the agent is done and the checks ran again. No tool reaches another repository's code.
 */
export function reposToolset(input: {
  repo: RepoRef
  options: WriteTaskOptions
  checks: readonly CheckSpec[]
  runChecks: (checks: readonly CheckSpec[]) => Promise<CheckResult[]>
  links?: WriteTaskLinks
  branch: string
  targetBranch: string
  onMergeRequest: (request: MergeRequestRequest) => void
}): Toolset {
  const { repo, options, links } = input
  return {
    name: 'repos',
    tools: [
      defineTool({
        name: 'list_related_repos',
        description:
          'Lists repositories related to this one (same group or family, other targets of this task) as forge:path. Read-only; you cannot change them from here.',
        input: z.object({}),
        async run() {
          const related = (await links?.related?.(repo, options)) ?? []
          return related.length
            ? related.map((entry) => `${entry.repo} (${entry.relation})`).join('\n')
            : 'No related repositories are known.'
        },
      }),
      defineTool({
        name: 'request_repository',
        description:
          'Asks people to add another repository (forge:path) to this task, e.g. when the change also needs a fix there. A person must approve; nothing happens in that repository from this run.',
        input: z.object({
          repo: z.string().min(3).describe('forge:path of the repository to add'),
          reason: z.string().trim().min(1).max(500),
        }),
        async run(args) {
          if (args.repo === `${repo.forge}:${repo.path}`)
            return 'That is the repository you are working on.'
          if (!links?.requestRepository) return 'Adding repositories is not available here.'
          return links.requestRepository({ repo, options, target: args.repo, reason: args.reason })
        },
      }),
      defineTool({
        name: 'run_checks',
        description:
          "Runs this repository's checks (install, lint, typecheck, tests) in the workspace and reports which fail, with the end of their output. Pass names to run only some.",
        input: z.object({
          names: z.array(z.string().min(1)).optional().describe('check names, e.g. ["typecheck"]'),
        }),
        async run(args) {
          const wanted = args.names?.length
            ? input.checks.filter((check) => args.names!.includes(check.name))
            : input.checks
          if (args.names?.length && wanted.length === 0)
            return `No such check. Checks: ${input.checks.map((check) => check.name).join(', ') || 'none'}.`
          return describeChecks(await input.runChecks(wanted))
        },
      }),
      defineTool({
        name: 'open_merge_request',
        description:
          'Sets the title and description of the merge request Holtkeeper opens from this workspace when you finish. It always targets this repository and the task branch; checks run again before it opens, and failing checks make it a draft.',
        input: z.object({
          title: z.string().trim().min(1).max(200),
          description: z.string().max(5000).optional(),
          draft: z.boolean().optional(),
        }),
        run(args) {
          input.onMergeRequest({
            title: args.title,
            ...(args.description?.trim() && { description: args.description.trim() }),
            ...(args.draft !== undefined && { draft: args.draft }),
          })
          return `Noted. The merge request from ${input.branch} into ${input.targetBranch} opens when you finish.`
        },
      }),
    ],
  }
}
