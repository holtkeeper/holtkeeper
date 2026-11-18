import type { Toolset } from '@holtkeeper/agent'
import { z } from 'zod'

import { type Budget, budgetOf, clip, limitLines } from './budget.ts'
import { defineTool } from './tool.ts'

/** The repository a task works on, as rules and learnings are scoped. */
export interface KnowledgeRepo {
  forge: string
  path: string
  /** Teams owning the repository; empty when nobody does. */
  teams: string[]
}

/** A rule or an active learning found by `search_knowledge`. */
export interface KnowledgeHit {
  /** The citation form: `rule:<id>` or `learn:<id>`. */
  id: string
  title: string
  body: string
  score: number
}

/** A rule an agent learned and proposes: one imperative sentence. */
export interface LearningProposal {
  text: string
  reason?: string
  /** Repository-relative path globs it is about. */
  files?: string[]
}

/**
 * Access to rules and learnings, implemented elsewhere. `search` returns rules and active
 * learnings that apply to the task's repository, best first; `propose` stores a learning for the
 * repository (pending or active per the approval policy) or reports the existing learning it
 * repeats.
 */
export interface KnowledgeAccess {
  search(
    query: string,
    ctx: { repo: KnowledgeRepo; taskKind: string; limit?: number },
  ): Promise<KnowledgeHit[]>
  propose(
    input: LearningProposal,
    ctx: { actor: string; repo: KnowledgeRepo; taskKind: string },
  ): Promise<{ id: string; status: string; duplicateOf?: string }>
}

export interface KnowledgeToolsOptions {
  access: KnowledgeAccess
  repo: KnowledgeRepo
  taskKind: string
  /** Who proposals are attributed to, e.g. `agent:review`. */
  actor: string
  budget?: Partial<Budget>
}

function bodyLines(body: string, budget: Budget, max: number): string[] {
  const lines = body
    .trim()
    .split(/\r?\n/)
    .map((line) => `  ${clip(line, budget.maxLineLength)}`)
  return limitLines(lines, max, 'lines')
}

/** Name of the read tool of `knowledgeTools`, the one requester-bound runs keep. */
export const SEARCH_KNOWLEDGE_TOOL = 'search_knowledge'

/** Name of the proposing tool of `knowledgeTools`. */
export const PROPOSE_LEARNING_TOOL = 'propose_learning'

/**
 * The `knowledge` toolset of internal tasks: `search_knowledge` (rules and active learnings of
 * this repository, bodies trimmed) and `propose_learning` (a one-sentence rule for this
 * repository, deduplicated against existing learnings).
 */
export function knowledgeTools(options: KnowledgeToolsOptions): Toolset {
  const budget = budgetOf(options.budget)
  const { access, repo, taskKind, actor } = options
  return {
    name: 'knowledge',
    tools: [
      defineTool({
        name: SEARCH_KNOWLEDGE_TOOL,
        description:
          'Search the team rules and learned rules that apply to this repository. Returns "[rule:<id>] title (score)" or "[learn:<id>] ..." with a trimmed body; cite what you apply in that form. Search before solving a problem that may have been solved before.',
        input: z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(20).optional().describe('Default 5'),
        }),
        async run({ query, limit = 5 }) {
          const hits = await access.search(query, { repo, taskKind, limit })
          if (hits.length === 0) return 'no rules or learnings found'
          const perHit = Math.max(
            3,
            Math.floor((budget.maxResultLines - 1) / Math.min(hits.length, limit)) - 1,
          )
          const lines = hits
            .slice(0, limit)
            .flatMap((hit) => [
              `[${hit.id}] ${clip(hit.title, budget.maxLineLength)} (${hit.score.toFixed(2)})`,
              ...bodyLines(hit.body, budget, perHit),
            ])
          return limitLines(lines, budget.maxResultLines, 'lines').join('\n')
        },
      }),
      defineTool({
        name: PROPOSE_LEARNING_TOOL,
        description:
          'Propose a learned rule for this repository: one short imperative sentence other tasks should follow (a convention, a pitfall), not a one-off fact. A rule the repository already has is not added again; new rules wait for the approval delay before agents use them.',
        input: z.object({
          text: z.string().min(1).max(300).describe('One imperative sentence'),
          reason: z.string().max(1000).optional().describe('Why it holds, with the evidence'),
          files: z
            .array(z.string().min(1))
            .max(10)
            .optional()
            .describe('Path globs it is about, e.g. src/widgets/**'),
        }),
        async run(input) {
          const result = await access.propose(
            {
              text: input.text,
              ...(input.reason && { reason: input.reason }),
              ...(input.files?.length && { files: input.files }),
            },
            { actor, repo, taskKind },
          )
          return result.duplicateOf
            ? `not added: repeats [learn:${result.duplicateOf}] (${result.status})`
            : `proposed [learn:${result.id}] (${result.status})`
        },
      }),
    ],
  }
}
