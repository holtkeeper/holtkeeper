import type { Scope } from '@holtkeeper/access'
import { scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import type { KnowledgeKind, KnowledgePackage, Store } from '@holtkeeper/store'

import { fusedRelevance } from './embeddings.ts'
import { type ProposeEntryOptions, proposeEntry } from './propose.ts'
import { appliesToTask, matchHolds, withoutSuperseded } from './select.ts'

/** A repository as agent tools describe it. */
export interface KnowledgeRepo {
  forge: string
  path: string
  /** Owner teams of the repository (`RepoTarget.teams`). */
  teams: string[]
  /** The repository's family id; without it, entries narrowed to families do not apply. */
  family?: string
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
   * Accepted entries matching `query` that apply to the repository (scope covers it, a
   * `match.families` holds its family; file matches do not narrow, the files are unknown) and the
   * task kind (`appliesTo` holds it or `*`), best first; superseded entries are left out. A blank query
   * lists every applicable entry, most specific scope first. `limit` defaults to 5. With the
   * `semantic` option, entries close in meaning (cosine from `SEMANTIC_MATCH` on) are found too,
   * even without a shared word, and the order is the reciprocal rank fusion of the full-text and
   * the vector ranking (`score` is then the fused value).
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
  store: Pick<Store, 'knowledge'> & Partial<Pick<Store, 'audit'>>
  now: () => Date
  /**
   * Kinds agent proposals are accepted for without review, or a function giving them for the
   * proposing repository (e.g. from a scoped setting). Default: none.
   */
  autoAccept?:
    | readonly KnowledgeKind[]
    | ((repo: KnowledgeRepo) => readonly KnowledgeKind[] | Promise<readonly KnowledgeKind[]>)
  /**
   * Entry id → cosine between the entry's vector and the query's, for a non-blank search query;
   * `undefined` (vectors off or not ready) leaves search full text only. A rejection does too.
   */
  semantic?: (query: string) => Promise<ReadonlyMap<string, number> | undefined>
  /**
   * The cosine function `proposeEntry` dedupes a proposal with (`ProposeEntryOptions.similarity`),
   * built for that proposal; `undefined` (or a rejection) dedupes by words only.
   */
  proposalSimilarity?: (
    proposal: KnowledgeProposal,
  ) => Promise<ProposeEntryOptions['similarity'] | undefined>
}

/** How many candidates a search ranks before the repository and task filters. */
const searchPool = 200

/** Cosine from which a search finds an entry by its vector alone, without a shared word. */
export const SEMANTIC_MATCH = 0.3

/** Search and propose for agent tools, bound to a store and a clock. */
export function knowledgeAccess({
  store,
  now,
  autoAccept,
  semantic,
  proposalSimilarity,
}: KnowledgeAccessOptions): KnowledgeAccess {
  return {
    async search(query, { repo, taskKind, limit = 5 }) {
      const blank = !query.trim()
      const [found, cosines] = await Promise.all([
        blank
          ? store.knowledge
              .list({ status: 'accepted' })
              .then((entries) => entries.map((entry) => ({ entry, score: 0 })))
          : store.knowledge.search(query, { status: 'accepted' }, searchPool),
        blank ? undefined : semantic?.(query).catch(() => undefined),
      ])
      let hits = found
      if (cosines?.size) {
        const known = new Set(found.map(({ entry }) => entry.id))
        const close = [...cosines].filter(
          ([id, cosine]) => cosine >= SEMANTIC_MATCH && !known.has(id),
        )
        if (close.length) {
          const ids = new Set(close.map(([id]) => id))
          const extra = (await store.knowledge.list({ status: 'accepted' })).filter((entry) =>
            ids.has(entry.id),
          )
          hits = [...found, ...extra.map((entry) => ({ entry, score: 0 }))]
        }
      }
      const applicable = hits.filter(
        ({ entry }) =>
          scopeCoversRepo(entry.scope, repo) &&
          matchHolds(entry.match, repo.family === undefined ? {} : { family: repo.family }) &&
          appliesToTask(entry, taskKind),
      )
      let kept = withoutSuperseded(applicable)
      if (cosines?.size) {
        const fused = fusedRelevance(
          kept.map(({ entry, score }) => ({ id: entry.id, lexical: score })),
          cosines,
        )
        kept = kept.map(({ entry }) => ({ entry, score: fused.get(entry.id) ?? 0 }))
      }
      return kept
        .toSorted(
          (a, b) =>
            b.score - a.score || scopeSpecificity(b.entry.scope) - scopeSpecificity(a.entry.scope),
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
      const [accepted, similarity] = await Promise.all([
        typeof autoAccept === 'function' ? autoAccept(ctx.repo) : autoAccept,
        proposalSimilarity?.(input).catch(() => undefined),
      ])
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
        ...(accepted !== undefined && { autoAccept: accepted }),
        ...(similarity && { similarity }),
      })
      return {
        id: result.entry.id,
        status: result.entry.status,
        ...(result.duplicateOf !== undefined && { duplicateOf: result.duplicateOf }),
      }
    },
  }
}
