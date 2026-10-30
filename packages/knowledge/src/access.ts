import type { Scope } from '@holtkeeper/access'
import { scopeCoversRepo } from '@holtkeeper/access'
import type { KnowledgeKind, KnowledgePackage, Store } from '@holtkeeper/store'

import { proposeEntry } from './propose.ts'
import { appliesToTask, withoutSuperseded } from './select.ts'
import { specificity } from './text.ts'

/** A repository as agent tools describe it. */
export interface KnowledgeRepo {
  forge: string
  path: string
  groups: string[]
}

/** One search result for an agent. Higher `score` is more relevant. */
export interface KnowledgeSearchResult {
  id: string
  title: string
  kind: KnowledgeKind
  body: string
  score: number
}

/** What an agent may propose. */
export interface KnowledgeProposal {
  title: string
  body: string
  kind?: KnowledgeKind
  topics?: string[]
  packages?: KnowledgePackage[]
  scope?: Scope
}

/** The outcome of a proposal; `duplicateOf` is set when an existing entry already says it. */
export interface KnowledgeProposalResult {
  id: string
  status: string
  duplicateOf?: string
}

/** The knowledge base as agent tools see it. */
export interface KnowledgeAccess {
  /**
   * Accepted entries matching `query` that apply to the repository (scope covers it) and the task
   * kind (`appliesTo` holds it or `*`), best first; superseded entries are left out. A blank query
   * lists every applicable entry, most specific scope first. `limit` defaults to 5.
   */
  search(
    query: string,
    ctx: { repo: KnowledgeRepo; taskKind: string; limit?: number },
  ): Promise<KnowledgeSearchResult[]>
  /** Proposes an entry (see `proposeEntry`); the scope defaults to the repository. */
  propose(
    input: KnowledgeProposal,
    ctx: {
      actor: string
      repo: KnowledgeRepo
      taskKind: string
      packages?: { ecosystem: string; name: string; from?: string; to?: string }[]
    },
  ): Promise<KnowledgeProposalResult>
}

export interface KnowledgeAccessOptions {
  store: Pick<Store, 'knowledge'> & Partial<Pick<Store, 'activity'>>
  now: () => Date
  /** Kinds agent proposals are accepted for without review. Default: none. */
  autoAccept?: readonly KnowledgeKind[]
}

/** How many candidates a search ranks before the repository and task filters. */
const searchPool = 200

/** Search and propose for agent tools, bound to a store and a clock. */
export function knowledgeAccess({
  store,
  now,
  autoAccept,
}: KnowledgeAccessOptions): KnowledgeAccess {
  return {
    async search(query, { repo, taskKind, limit = 5 }) {
      const hits = query.trim()
        ? await store.knowledge.search(query, { status: 'accepted' }, searchPool)
        : (await store.knowledge.list({ status: 'accepted' })).map((entry) => ({ entry, score: 0 }))
      const applicable = hits.filter(
        ({ entry }) => scopeCoversRepo(entry.scope, repo) && appliesToTask(entry, taskKind),
      )
      return withoutSuperseded(applicable)
        .toSorted(
          (a, b) => b.score - a.score || specificity(b.entry.scope) - specificity(a.entry.scope),
        )
        .slice(0, limit)
        .map(({ entry, score }) => ({
          id: entry.id,
          title: entry.title,
          kind: entry.kind,
          body: entry.body,
          score,
        }))
    },
    async propose(input, ctx) {
      const result = await proposeEntry({
        store,
        input,
        actor: ctx.actor,
        task: {
          kind: ctx.taskKind,
          repo: ctx.repo,
          ...(ctx.packages !== undefined && { packages: ctx.packages }),
        },
        now,
        ...(autoAccept !== undefined && { autoAccept }),
      })
      return {
        id: result.entry.id,
        status: result.entry.status,
        ...(result.duplicateOf !== undefined && { duplicateOf: result.duplicateOf }),
      }
    },
  }
}
