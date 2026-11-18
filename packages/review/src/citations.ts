import type { ReactionSignal } from '@holtkeeper/store'

import type { ReviewData } from './schema.ts'

/**
 * What became of a review comment that cited a rule or a learning:
 *
 * - `fixed`: the merge request was merged and the commented lines changed after the review;
 * - `resolved`: merged, the thread resolved with the lines unchanged;
 * - `dismissed`: merged with the thread still open and the lines unchanged;
 * - `open`: the merge request is still open (no outcome read yet);
 * - `closed`: the merge request was closed without merging, which says nothing about the comment;
 * - `unknown`: merged, but the forge could not tell.
 */
export type CitationOutcome = 'fixed' | 'resolved' | 'dismissed' | 'open' | 'closed' | 'unknown'

/** One posted review comment citing one rule (`[rule:<id>]`) or learning (`[learn:<id>]`). */
export interface RuleCitation {
  kind: 'rule' | 'learn'
  /** The id as cited. */
  id: string
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

/** How the comments citing a rule or learning fared. */
export interface CitationSummary {
  /** Posted comments citing it. */
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

const CITATION = /\[\s*(rule|learn)\s*:\s*([A-Za-z0-9][\w-]*)\s*\]/g

/** A rule or learning a text cites. */
export interface CitedRule {
  kind: 'rule' | 'learn'
  id: string
}

/**
 * The rules (`[rule:<id>]`) and learnings (`[learn:<id>]`) `text` cites, each once, in order of
 * appearance.
 */
export function citedRules(text: string): CitedRule[] {
  const found = new Map<string, CitedRule>()
  for (const match of text.matchAll(CITATION)) {
    const kind = match[1] === 'rule' ? 'rule' : 'learn'
    const id = match[2] ?? ''
    if (id && !found.has(`${kind}:${id}`)) found.set(`${kind}:${id}`, { kind, id })
  }
  return [...found.values()]
}

/** A stored review run, as `ruleCitations` reads it. */
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
 * Every posted review comment citing a rule or learning (in its title or body) across `runs`,
 * joined with the comment's stored signal (`ReactionSignal` of the same repository, merge request
 * and finding id) for its outcome, replies and reactions. A finding posted by several runs of a
 * merge request counts once, at the first run; comments the forge rejected never count. Sorted
 * newest first, then by citation, repository, merge request and finding.
 */
export function ruleCitations(
  runs: Iterable<CitingRun>,
  signals: Iterable<ReactionSignal>,
): RuleCitation[] {
  const byFinding = new Map<string, ReactionSignal>()
  for (const signal of signals)
    if (signal.findingId !== undefined)
      byFinding.set(`${signal.repo}\u0000${signal.mergeRequest}\u0000${signal.findingId}`, signal)
  const found = new Map<string, RuleCitation>()
  for (const run of runs)
    for (const comment of run.data.comments) {
      if (!comment.posted) continue
      const cited = citedRules(`${comment.title}\n${comment.body}`)
      if (!cited.length) continue
      const finding = `${run.repo}\u0000${run.data.mergeRequest.id}\u0000${comment.id}`
      const signal = byFinding.get(finding)
      for (const { kind, id } of cited) {
        const key = `${kind}:${id}\u0000${finding}`
        const known = found.get(key)
        if (known && known.at <= run.createdAt) continue
        found.set(key, {
          kind,
          id,
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
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`) ||
      a.repo.localeCompare(b.repo) ||
      a.mergeRequest - b.mergeRequest ||
      a.findingId.localeCompare(b.findingId),
  )
}

/** Counts of `citations` by outcome, with replies, reactions and the newest time. */
export function summarizeCitations(citations: Iterable<RuleCitation>): CitationSummary {
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
