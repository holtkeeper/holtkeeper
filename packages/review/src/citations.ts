import type { ReactionSignal } from '@holtkeeper/store'

import type { ReviewData } from './schema.ts'

/**
 * What became of a review comment that cited a knowledge entry:
 *
 * - `fixed`: the merge request was merged and the commented lines changed after the review;
 * - `resolved`: merged, the thread resolved with the lines unchanged;
 * - `dismissed`: merged with the thread still open and the lines unchanged;
 * - `open`: the merge request is still open (no outcome read yet);
 * - `closed`: the merge request was closed without merging, which says nothing about the comment;
 * - `unknown`: merged, but the forge could not tell.
 */
export type CitationOutcome = 'fixed' | 'resolved' | 'dismissed' | 'open' | 'closed' | 'unknown'

/** One posted review comment citing one knowledge entry. */
export interface KnowledgeCitation {
  /** The entry id as cited (`[kb:<id>]`). */
  entry: string
  /** `forge:path`. */
  repo: string
  mergeRequest: number
  findingId: string
  /** The comment's title. */
  title: string
  severity: string
  category: string
  /** Link to the comment on the forge. */
  href?: string
  /** Creation time of the first review run that posted the comment. */
  at: string
  outcome: CitationOutcome
  /** Notes in the thread written by people other than Holtkeeper (0 until the outcome is read). */
  replies: number
  up: number
  down: number
}

/** How the comments citing an entry fared. */
export interface CitationSummary {
  /** Posted comments citing the entry. */
  comments: number
  fixed: number
  resolved: number
  dismissed: number
  open: number
  closed: number
  unknown: number
  /** Comments people replied to. */
  replied: number
  /** 👍 and 👎 on the comments. */
  up: number
  down: number
  /** The newest citing comment's review time. */
  lastCitedAt?: string
}

const CITATION = /\[\s*kb:\s*([A-Za-z0-9][\w-]*)\s*\]/g

/** Ids of the knowledge entries `text` cites as `[kb:<id>]`, each once, in order of appearance. */
export function citedIds(text: string): string[] {
  return [...new Set([...text.matchAll(CITATION)].map((match) => match[1] ?? '').filter(Boolean))]
}

/** A stored review run, as `knowledgeCitations` reads it. */
export interface CitingRun {
  /** `forge:path`. */
  repo: string
  createdAt: string
  data: Pick<ReviewData, 'mergeRequest' | 'comments'>
}

const outcomeOf = (signal: ReactionSignal | undefined): CitationOutcome => {
  if (signal?.mergeRequestState === 'closed') return 'closed'
  if (signal?.mergeRequestState !== 'merged' || !signal.outcome) return 'open'
  if (signal.outcome === 'ignored') return 'dismissed'
  return signal.outcome
}

/**
 * Every posted review comment citing a knowledge entry (in its title or body) across `runs`,
 * joined with the comment's stored signal (`ReactionSignal` of the same repository, merge request
 * and finding id) for its outcome, replies and reactions. A finding posted by several runs of a
 * merge request counts once, at the first run; comments the forge rejected never count. Sorted
 * newest first, then by entry, repository, merge request and finding.
 */
export function knowledgeCitations(
  runs: Iterable<CitingRun>,
  signals: Iterable<ReactionSignal>,
): KnowledgeCitation[] {
  const byFinding = new Map<string, ReactionSignal>()
  for (const signal of signals)
    if (signal.findingId !== undefined)
      byFinding.set(`${signal.repo}\u0000${signal.mergeRequest}\u0000${signal.findingId}`, signal)
  const found = new Map<string, KnowledgeCitation>()
  for (const run of runs)
    for (const comment of run.data.comments) {
      if (!comment.posted) continue
      const ids = citedIds(`${comment.title}\n${comment.body}`)
      if (!ids.length) continue
      const finding = `${run.repo}\u0000${run.data.mergeRequest.id}\u0000${comment.id}`
      const signal = byFinding.get(finding)
      for (const entry of ids) {
        const key = `${entry}\u0000${finding}`
        const known = found.get(key)
        if (known && known.at <= run.createdAt) continue
        found.set(key, {
          entry,
          repo: run.repo,
          mergeRequest: run.data.mergeRequest.id,
          findingId: comment.id,
          title: comment.title,
          severity: comment.severity,
          category: comment.category,
          ...(comment.href && { href: comment.href }),
          at: run.createdAt,
          outcome: outcomeOf(signal),
          replies: signal?.humanReplies ?? 0,
          up: signal?.up ?? 0,
          down: signal?.down ?? 0,
        })
      }
    }
  return [...found.values()].toSorted(
    (a, b) =>
      b.at.localeCompare(a.at) ||
      a.entry.localeCompare(b.entry) ||
      a.repo.localeCompare(b.repo) ||
      a.mergeRequest - b.mergeRequest ||
      a.findingId.localeCompare(b.findingId),
  )
}

/** Counts of `citations` by outcome, with replies, reactions and the newest time. */
export function summarizeCitations(citations: Iterable<KnowledgeCitation>): CitationSummary {
  const summary: CitationSummary = {
    comments: 0,
    fixed: 0,
    resolved: 0,
    dismissed: 0,
    open: 0,
    closed: 0,
    unknown: 0,
    replied: 0,
    up: 0,
    down: 0,
  }
  for (const citation of citations) {
    summary.comments++
    summary[citation.outcome]++
    if (citation.replies > 0) summary.replied++
    summary.up += citation.up
    summary.down += citation.down
    if (!summary.lastCitedAt || citation.at > summary.lastCitedAt) summary.lastCitedAt = citation.at
  }
  return summary
}
