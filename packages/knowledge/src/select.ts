import { scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import type { KnowledgeEntry } from '@holtkeeper/store'

import type { KnowledgeTask } from './model.ts'
import { describePackage, packagesOverlap } from './semver.ts'
import { estimateTokens, relevance } from './text.ts'

/** Whether an entry is meant for tasks of `kind`: `appliesTo` holds the kind or `*`. */
export const appliesToTask = (entry: KnowledgeEntry, kind: string): boolean =>
  entry.appliesTo.includes('*') || entry.appliesTo.includes(kind)

/**
 * Whether an accepted entry belongs in the context of `task`: its scope covers the repository,
 * it applies to the task kind, and — for migrations — one of the task's packages overlaps the
 * entry's version ranges. Migrations never match tasks without packages.
 */
export function matchesTask(entry: KnowledgeEntry, task: KnowledgeTask): boolean {
  if (entry.status !== 'accepted') return false
  if (!scopeCoversRepo(entry.scope, task.repo)) return false
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
}

export interface SelectedKnowledge {
  entry: KnowledgeEntry
  /** Text relevance to the task query and packages; 0 without a query. */
  score: number
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
 * superseded by another match are dropped. Ranking: more specific scope first (exact repository
 * over globs over groups over everything, like settings), then relevance to `task.query` and the
 * task's packages, then the most recently updated. Entries are added in that order while the
 * rendered block stays within `budgetTokens`; an entry too large to fit is skipped, not cut.
 */
export function selectForTask({
  entries,
  task,
  budgetTokens,
}: SelectForTaskInput): KnowledgeSelection {
  const query = [task.query ?? '', ...(task.packages ?? []).map((pkg) => pkg.name)].join(' ')
  const ranked = withoutSuperseded(
    entries
      .filter((entry) => matchesTask(entry, task))
      .map((entry) => ({
        entry,
        score: relevance(entry, query),
        specificity: scopeSpecificity(entry.scope),
      })),
  ).toSorted(
    (a, b) =>
      b.specificity - a.specificity ||
      b.score - a.score ||
      b.entry.updatedAt.localeCompare(a.entry.updatedAt),
  )

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
