import { patternWithin, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import type { KnowledgeEntry, KnowledgeMatch } from '@holtkeeper/store'

import { fusedRelevance } from './embeddings.ts'
import { knowledgeLinks, linkIndex } from './graph.ts'
import type { KnowledgeTask } from './model.ts'
import { describePackage, packagesOverlap } from './semver.ts'
import { estimateTokens, relevance } from './text.ts'

/** Whether an entry is meant for tasks of `kind`: `appliesTo` holds the kind or `*`. */
export const appliesToTask = (entry: KnowledgeEntry, kind: string): boolean =>
  entry.appliesTo.includes('*') || entry.appliesTo.includes(kind)

const relative = (file: string) => file.replace(/^(\.\/|\/)+/, '')

/**
 * Whether an entry's `match` holds for a task: `families` needs the task's family among them (a
 * task without a family fails it), `files` needs one task file to match one of the globs
 * (`Bun.Glob`, repository-relative) — but only when the task says which files it touches. An absent
 * match, and empty lists, hold for everything. Deterministic: no similarity is involved.
 */
export function matchHolds(
  match: KnowledgeMatch | undefined,
  task: Pick<KnowledgeTask, 'family' | 'files'>,
): boolean {
  const families = match?.families ?? []
  if (families.length && (task.family === undefined || !families.includes(task.family)))
    return false
  const files = match?.files ?? []
  if (files.length && task.files !== undefined) {
    const globs = files.map((pattern) => new Bun.Glob(relative(pattern)))
    if (!task.files.some((file) => globs.some((glob) => glob.match(relative(file))))) return false
  }
  return true
}

/**
 * Whether `inner` applies nowhere `outer` does not: each narrowing of `outer` is at least as narrow
 * in `inner` (its families a subset, each of its file globs equal to or within one of `outer`'s).
 * An absent match applies everywhere, so it is only within another absent or empty one.
 */
export function matchWithin(
  inner: KnowledgeMatch | undefined,
  outer: KnowledgeMatch | undefined,
): boolean {
  const outerFamilies = outer?.families ?? []
  const innerFamilies = inner?.families ?? []
  if (
    outerFamilies.length &&
    (!innerFamilies.length || !innerFamilies.every((family) => outerFamilies.includes(family)))
  )
    return false
  const outerFiles = (outer?.files ?? []).map(relative)
  const innerFiles = (inner?.files ?? []).map(relative)
  return (
    !outerFiles.length ||
    (innerFiles.length > 0 &&
      innerFiles.every((glob) =>
        outerFiles.some((candidate) => candidate === glob || patternWithin(glob, candidate)),
      ))
  )
}

/** Whether the entry narrows where it applies (`match` with families or files). */
export const isNarrowed = (entry: Pick<KnowledgeEntry, 'match'>): boolean =>
  Boolean(entry.match?.families?.length || entry.match?.files?.length)

/**
 * Whether an accepted entry belongs in the context of `task`: its scope covers the repository,
 * its `match` holds (`matchHolds`: the task's family, the files it touches), it applies to the
 * task kind, and — for migrations — one of the task's packages overlaps the entry's version
 * ranges. Migrations never match tasks without packages.
 */
export function matchesTask(entry: KnowledgeEntry, task: KnowledgeTask): boolean {
  if (entry.status !== 'accepted') return false
  if (!scopeCoversRepo(entry.scope, task.repo)) return false
  if (!matchHolds(entry.match, task)) return false
  if (!appliesToTask(entry, task.kind)) return false
  if (entry.kind === 'migration') return packagesOverlap(entry.packages ?? [], task.packages ?? [])
  return true
}

/** Drops entries that another entry in the list supersedes. */
export const withoutSuperseded = <T extends { entry: KnowledgeEntry }>(items: T[]): T[] => {
  const replaced = new Set(items.flatMap(({ entry }) => entry.supersedes ?? []))
  return items.filter(({ entry }) => !replaced.has(entry.id))
}

/** How an entry is cited in agent context and output: `[kb:<id>]`. */
export const citation = (id: string) => `[kb:${id}]`

/** One entry as a compact markdown block headed by its citation. */
export function renderEntry(entry: KnowledgeEntry): string {
  const meta = [
    entry.kind,
    ...(entry.packages ?? []).map(describePackage),
    ...(entry.topics.length ? [`topics: ${entry.topics.join(', ')}`] : []),
  ].join(' · ')
  return `### ${citation(entry.id)} ${entry.title}\n_${meta}_\n\n${entry.body.trim()}\n`
}

const header =
  '## Team knowledge\n\nAccepted decisions and conventions for this repository. Follow them, and cite an entry as [kb:<id>] when you rely on it.\n\n'

export interface SelectForTaskInput {
  entries: readonly KnowledgeEntry[]
  task: KnowledgeTask
  /** Upper bound for the rendered block, estimated at four characters per token. */
  budgetTokens: number
  /**
   * Entry id → cosine between the entry's vector and the task's query vector. Only ranks: entries
   * still have to match the task, and entries without a vector are not left out.
   */
  semantic?: ReadonlyMap<string, number>
  /**
   * Pull entries linked to the best ones forward (`pullRelated`): under a tight budget the
   * knowledge that belongs with what is read goes in before unrelated entries. Only reorders
   * entries that already match the task.
   */
  related?: boolean
}

/** How many of the best entries (in rank order) pull the entries linked to them forward. */
export const RELATED_ANCHORS = 3

/**
 * Moves each entry linked (`knowledgeLinks`) to one of the first `RELATED_ANCHORS` entries of
 * `ranked` to just behind the last anchor, keeping the order among them and among the rest. The
 * anchors themselves never move.
 */
export function pullRelated<T extends { entry: KnowledgeEntry }>(ranked: readonly T[]): T[] {
  const anchors = ranked.slice(0, RELATED_ANCHORS)
  const links = linkIndex(knowledgeLinks(ranked.map((item) => item.entry)))
  const pulled = new Set(anchors.flatMap(({ entry }) => links.get(entry.id) ?? []))
  const rest = ranked.slice(RELATED_ANCHORS)
  return [
    ...anchors,
    ...rest.filter(({ entry }) => pulled.has(entry.id)),
    ...rest.filter(({ entry }) => !pulled.has(entry.id)),
  ]
}

export interface SelectedKnowledge {
  entry: KnowledgeEntry
  /**
   * Relevance to the task: the text relevance to the task query and packages (0 without a query);
   * with `semantic`, the reciprocal rank fusion of the text ranking and the vector ranking among
   * the matching entries (Σ 1/(60 + rank), so at most 2/61; 0 when in neither ranking).
   */
  score: number
  /** `scopeSpecificity` of the entry's scope. */
  specificity: number
}

export interface KnowledgeSelection {
  /** Entries in the rendered block, in order. */
  selected: SelectedKnowledge[]
  /** Entries that matched the task but did not fit the budget. */
  omitted: SelectedKnowledge[]
  /** The context block for the agent; empty when nothing fits. */
  markdown: string
  /** Estimated tokens of `markdown`. */
  tokens: number
}

/**
 * Picks the knowledge an agent should read for a task. Entries must pass `matchesTask`; entries
 * superseded by another match are dropped. Ranking: more specific scope first
 * (`scopeSpecificity`: exact repository > folder glob, deeper first > team > everything, like
 * settings), then among equally specific scopes an entry narrowed by `match` first, then relevance
 * to `task.query` and the task's packages, then the most recently updated. With `semantic`,
 * relevance fuses the text ranking with the ranking by cosine (`fusedRelevance`: entries without a
 * vector rank last in the latter); applicability never depends on it. Entries are added in
 * that order while the rendered block stays within `budgetTokens`; an entry too large to fit is
 * skipped, not cut.
 */
export function selectForTask({
  entries,
  task,
  budgetTokens,
  semantic,
  related,
}: SelectForTaskInput): KnowledgeSelection {
  const query = [task.query ?? '', ...(task.packages ?? []).map((pkg) => pkg.name)].join(' ')
  const matching = withoutSuperseded(
    entries
      .filter((entry) => matchesTask(entry, task))
      .map((entry) => ({
        entry,
        score: relevance(entry, query),
        specificity: scopeSpecificity(entry.scope),
      })),
  )
  if (semantic) {
    // Ties of the text ranking go to the newer entry, as in the final order.
    const fused = fusedRelevance(
      matching
        .toSorted((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt))
        .map((item) => ({ id: item.entry.id, lexical: item.score })),
      semantic,
    )
    for (const item of matching) item.score = fused.get(item.entry.id) ?? 0
  }
  const sorted = matching.toSorted(
    (a, b) =>
      b.specificity - a.specificity ||
      Number(isNarrowed(b.entry)) - Number(isNarrowed(a.entry)) ||
      b.score - a.score ||
      b.entry.updatedAt.localeCompare(a.entry.updatedAt),
  )

  const ranked = related ? pullRelated(sorted) : sorted
  const selected: SelectedKnowledge[] = []
  const omitted: SelectedKnowledge[] = []
  let markdown = header
  for (const item of ranked) {
    const block = `${renderEntry(item.entry)}\n`
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
