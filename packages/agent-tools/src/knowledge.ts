import type { Toolset } from '@holtkeeper/agent'
import { z } from 'zod'

import { type Budget, budgetOf, clip, limitLines } from './budget.ts'
import { defineTool } from './tool.ts'

/** The repository a task works on, as the knowledge base scopes entries. */
export interface KnowledgeRepo {
  forge: string
  path: string
  groups: string[]
}

/** A package (and optionally a version step) a knowledge entry is about. */
export interface KnowledgePackage {
  ecosystem: string
  name: string
  from?: string
  to?: string
}

export interface KnowledgeHit {
  id: string
  title: string
  kind: string
  body: string
  score: number
}

export interface KnowledgeProposal {
  title: string
  body: string
  kind?: string
  topics?: string[]
  packages?: KnowledgePackage[]
}

/**
 * Access to the shared knowledge base, implemented elsewhere. `search` returns entries relevant
 * to the query in the task's scope, best first; `propose` submits a new entry for review and may
 * report it as a duplicate of an existing one.
 */
export interface KnowledgeAccess {
  search(
    query: string,
    ctx: { repo: KnowledgeRepo; taskKind: string; limit?: number },
  ): Promise<KnowledgeHit[]>
  propose(
    input: KnowledgeProposal,
    ctx: { actor: string; repo: KnowledgeRepo; taskKind: string; packages?: KnowledgePackage[] },
  ): Promise<{ id: string; status: string; duplicateOf?: string }>
}

export interface KnowledgeToolsOptions {
  access: KnowledgeAccess
  repo: KnowledgeRepo
  taskKind: string
  /** Who proposals are attributed to, e.g. `agent:review`. */
  actor: string
  /** Packages the task is about; passed to `propose` as context. */
  packages?: KnowledgePackage[]
  budget?: Partial<Budget>
}

const packageSchema = z.object({
  ecosystem: z.string().min(1),
  name: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
})

function bodyLines(body: string, budget: Budget, max: number): string[] {
  const lines = body
    .trim()
    .split(/\r?\n/)
    .map((line) => `  ${clip(line, budget.maxLineLength)}`)
  return limitLines(lines, max, 'lines')
}

/**
 * The `knowledge` toolset: `knowledge.search` (entries for this repository and task kind, bodies
 * trimmed) and `knowledge.propose` (submit a lesson learned for review).
 */
export function knowledgeTools(options: KnowledgeToolsOptions): Toolset {
  const budget = budgetOf(options.budget)
  const { access, repo, taskKind, actor } = options
  return {
    name: 'knowledge',
    tools: [
      defineTool({
        name: 'knowledge.search',
        description:
          'Search the team knowledge base (conventions, past fixes, upgrade notes) for this repository. Returns "[id] kind: title (score)" with a trimmed body. Search before solving a problem that may have been solved before.',
        input: z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(20).optional().describe('Default 5'),
        }),
        async run({ query, limit = 5 }) {
          const hits = await access.search(query, { repo, taskKind, limit })
          if (hits.length === 0) return 'no knowledge entries found'
          const perHit = Math.max(
            3,
            Math.floor((budget.maxResultLines - 1) / Math.min(hits.length, limit)) - 1,
          )
          const lines = hits
            .slice(0, limit)
            .flatMap((hit) => [
              `[${hit.id}] ${hit.kind}: ${clip(hit.title, budget.maxLineLength)} (${hit.score.toFixed(2)})`,
              ...bodyLines(hit.body, budget, perHit),
            ])
          return limitLines(lines, budget.maxResultLines, 'lines').join('\n')
        },
      }),
      defineTool({
        name: 'knowledge.propose',
        description:
          'Propose a knowledge entry: a reusable lesson (convention, pitfall, upgrade step) other tasks should know. Keep it short and general; it is reviewed before it is used.',
        input: z.object({
          title: z.string().min(1).max(200),
          body: z.string().min(1).max(8000),
          kind: z.string().optional().describe('e.g. convention, pitfall, migration'),
          topics: z.array(z.string()).optional(),
          packages: z.array(packageSchema).optional(),
        }),
        async run(input) {
          const proposal: KnowledgeProposal = { title: input.title, body: input.body }
          if (input.kind) proposal.kind = input.kind
          if (input.topics) proposal.topics = input.topics
          if (input.packages)
            proposal.packages = input.packages.map((pkg) => ({
              ecosystem: pkg.ecosystem,
              name: pkg.name,
              ...(pkg.from !== undefined ? { from: pkg.from } : {}),
              ...(pkg.to !== undefined ? { to: pkg.to } : {}),
            }))
          const result = await access.propose(proposal, {
            actor,
            repo,
            taskKind,
            ...(options.packages ? { packages: options.packages } : {}),
          })
          return result.duplicateOf
            ? `not added: duplicate of ${result.duplicateOf} (${result.status})`
            : `proposed ${result.id} (${result.status})`
        },
      }),
    ],
  }
}
