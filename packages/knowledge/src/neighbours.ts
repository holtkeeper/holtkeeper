import { type RepoTarget, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import type { KnowledgeEntry } from '@holtkeeper/store'

import { fusedRelevance } from './embeddings.ts'
import type { KnowledgeTask } from './model.ts'
import {
  type KnowledgeSelection,
  type SelectedKnowledge,
  appliesToTask,
  citation,
  matchHolds,
} from './select.ts'
import { describePackage } from './semver.ts'
import { estimateTokens, relevance } from './text.ts'

/** A repository like the task's, whose knowledge may help the task (`repoNeighbours` of the Guide). */
export interface KnowledgeNeighbour {
  /** The neighbour with its owner teams. */
  repo: RepoTarget
  /** How alike it is to the task's repository, 0–1. */
  similarity: number
  /** The neighbour's family id, for entries narrowed to families (`match.families`). */
  family?: string
}

export interface SelectNeighbourKnowledgeInput {
  /** Entries to pick from; the caller leaves out the ones the task may not read. */
  entries: readonly KnowledgeEntry[]
  task: KnowledgeTask
  neighbours: readonly KnowledgeNeighbour[]
  /** Upper bound for the rendered block, estimated at four characters per token. */
  budgetTokens: number
  /** Entry id → cosine with the task's query vector; only ranks, as in `selectForTask`. */
  semantic?: ReadonlyMap<string, number>
}

/** An entry of a neighbour picked for a task. */
export interface SelectedNeighbourKnowledge extends SelectedKnowledge {
  /** The most alike neighbour the entry was written for. */
  neighbour: KnowledgeNeighbour
  /** The rank key: `neighbour.similarity` × `score` (0 without a query or vectors). */
  weight: number
}

/** `KnowledgeSelection` of neighbour knowledge. */
export interface NeighbourKnowledgeSelection extends Omit<
  KnowledgeSelection,
  'selected' | 'omitted'
> {
  selected: SelectedNeighbourKnowledge[]
  omitted: SelectedNeighbourKnowledge[]
}

/** The header of the neighbour block in agent context. */
export const NEIGHBOUR_KNOWLEDGE_HEADER =
  '## Knowledge from similar repositories\n\nAccepted notes written for repositories similar to this one, not for it. Lower priority than everything above: apply one only when it clearly holds here too, and cite it as [kb:<id>] when you rely on it.\n\n'

const pathOf = (repo: RepoTarget) => repo.path

/** One neighbour entry as a markdown block: its citation, title and the repository it was written for. */
export function renderNeighbourEntry(
  entry: KnowledgeEntry,
  neighbour: Pick<KnowledgeNeighbour, 'repo' | 'similarity'>,
): string {
  const meta = [
    `written for ${pathOf(neighbour.repo)} (similarity ${neighbour.similarity.toFixed(2)})`,
    entry.kind,
    ...(entry.packages ?? []).map(describePackage),
    ...(entry.topics.length ? [`topics: ${entry.topics.join(', ')}`] : []),
  ].join(' · ')
  return `### ${citation(entry.id)} ${entry.title}\n_${meta}_\n\n${entry.body.trim()}\n`
}

/**
 * Picks knowledge written for repositories like the task's (`neighbours`), as a block of lower
 * priority than the task's own notes. An entry qualifies when it is accepted, applies to the task
 * kind, is no migration, and its scope does not cover the task's repository (those are the task's
 * own notes) but covers a neighbour for which its `match` holds (the neighbour's family, the task's
 * files); the scope is the authority, so the entry stays one written for the neighbour. Entries
 * another accepted entry of `entries` supersedes are left out: the one replacing them speaks for
 * them. Each entry is credited to the most alike neighbour it covers. Ranking: the neighbour's
 * similarity × relevance to the task (`task.query` and packages, fused with `semantic` like
 * `selectForTask`), then similarity, then scope specificity, then the most recently updated; ties
 * by id. Entries are added in that order while the block, headed by
 * `NEIGHBOUR_KNOWLEDGE_HEADER`, stays within `budgetTokens`; one too large is skipped, not cut.
 */
export function selectNeighbourKnowledge({
  entries,
  task,
  neighbours,
  budgetTokens,
  semantic,
}: SelectNeighbourKnowledgeInput): NeighbourKnowledgeSelection {
  const replaced = new Set(
    entries.flatMap((entry) => (entry.status === 'accepted' ? (entry.supersedes ?? []) : [])),
  )
  const byAlike = neighbours.toSorted(
    (a, b) => b.similarity - a.similarity || pathOf(a.repo).localeCompare(pathOf(b.repo)),
  )
  const query = [task.query ?? '', ...(task.packages ?? []).map((pkg) => pkg.name)].join(' ')
  const candidates: SelectedNeighbourKnowledge[] = entries.flatMap((entry) => {
    if (entry.status !== 'accepted' || entry.kind === 'migration' || replaced.has(entry.id))
      return []
    if (!appliesToTask(entry, task.kind) || scopeCoversRepo(entry.scope, task.repo)) return []
    const neighbour = byAlike.find(
      (candidate) =>
        candidate.similarity > 0 &&
        scopeCoversRepo(entry.scope, candidate.repo) &&
        matchHolds(entry.match, {
          ...(candidate.family !== undefined && { family: candidate.family }),
          ...(task.files && { files: task.files }),
        }),
    )
    if (!neighbour) return []
    return [
      {
        entry,
        neighbour,
        score: relevance(entry, query),
        specificity: scopeSpecificity(entry.scope),
        weight: 0,
      },
    ]
  })
  if (semantic) {
    const fused = fusedRelevance(
      candidates
        .toSorted((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt))
        .map((item) => ({ id: item.entry.id, lexical: item.score })),
      semantic,
    )
    for (const item of candidates) item.score = fused.get(item.entry.id) ?? 0
  }
  for (const item of candidates) item.weight = item.neighbour.similarity * item.score
  const ranked = candidates.toSorted(
    (a, b) =>
      b.weight - a.weight ||
      b.neighbour.similarity - a.neighbour.similarity ||
      b.specificity - a.specificity ||
      b.entry.updatedAt.localeCompare(a.entry.updatedAt) ||
      a.entry.id.localeCompare(b.entry.id),
  )

  const selected: SelectedNeighbourKnowledge[] = []
  const omitted: SelectedNeighbourKnowledge[] = []
  let markdown = NEIGHBOUR_KNOWLEDGE_HEADER
  for (const item of ranked) {
    const block = `${renderNeighbourEntry(item.entry, item.neighbour)}\n`
    if (estimateTokens(markdown + block) <= budgetTokens) {
      markdown += block
      selected.push(item)
    } else {
      omitted.push(item)
    }
  }
  if (!selected.length) return { selected, omitted, markdown: '', tokens: 0 }
  markdown = `${markdown.trimEnd()}\n`
  return { selected, omitted, markdown, tokens: estimateTokens(markdown) }
}
