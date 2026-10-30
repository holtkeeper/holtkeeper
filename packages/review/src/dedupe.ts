import type { Discussion } from '@holtkeeper/forge'

import { type ReviewSeverity, severities } from './schema.ts'
import type { Candidate } from './validate.ts'

/** Hidden marker every note Holtkeeper posts carries, so later runs recognize their own threads. */
export const MARKER_PREFIX = 'holtkeeper:review'

export const findingMarker = (id: string) => `<!-- ${MARKER_PREFIX} id=${id} -->`

const markerPattern = /<!-- holtkeeper:review(?: id=([\w-]+))?[^>]*-->/

/** The finding id in a note's marker, `''` for a marker without one, `undefined` without a marker. */
export function markerOf(body: string): string | undefined {
  const match = markerPattern.exec(body)
  return match ? (match[1] ?? '') : undefined
}

/** An unresolved diff thread, as dedupe and re-checks see it. */
export interface OpenThread {
  discussionId: string
  path: string
  line: number
  /** Text of the first note, without markers. */
  text: string
  /** Started by Holtkeeper. */
  ours: boolean
  /** Finding id from our marker. */
  findingId?: string
}

/** Unresolved threads on diff lines; `ours` is decided by the marker or the bot's username. */
export function openThreads(
  discussions: readonly Discussion[],
  botUsername?: string,
): OpenThread[] {
  return discussions.flatMap((discussion): OpenThread[] => {
    const first = discussion.notes.find((note) => !note.system)
    if (!discussion.position || discussion.resolved || !first) return []
    const marker = markerOf(first.body)
    return [
      {
        discussionId: discussion.id,
        path: discussion.position.path,
        line: discussion.position.line,
        text: first.body.replace(new RegExp(markerPattern.source, 'g'), '').trim(),
        ours: marker !== undefined || (botUsername !== undefined && first.author === botUsername),
        ...(marker ? { findingId: marker } : {}),
      },
    ]
  })
}

const tokensOf = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/```[\s\S]*?```/g, ' ')
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length >= 3),
  )

/**
 * How alike two comments read, 0..1: the larger of the Jaccard index and a damped overlap
 * coefficient of their words, so a short comment repeated inside a longer one still counts.
 */
export function similarity(a: string, b: string): number {
  const left = tokensOf(a)
  const right = tokensOf(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  const jaccard = shared / (left.size + right.size - shared)
  const overlap =
    Math.min(left.size, right.size) >= 3 ? (shared / Math.min(left.size, right.size)) * 0.8 : 0
  return Math.max(jaccard, overlap)
}

/** Threshold above which two comments are considered the same. */
export const SIMILAR = 0.45

/** How many lines apart two comments may be and still be the same. */
export const LINE_TOLERANCE = 2

const textOf = (candidate: Candidate) => `${candidate.title}\n${candidate.body}`

const near = (a: { path: string; line: number }, b: { path: string; line: number }) =>
  a.path === b.path && Math.abs(a.line - b.line) <= LINE_TOLERANCE

export interface DedupeResult {
  kept: Candidate[]
  /** Candidates that repeat an open thread; `thread.ours` ones may deserve a reply instead. */
  repeats: { candidate: Candidate; thread: OpenThread }[]
  /** Candidates that repeat a deterministic finding or an earlier candidate. */
  duplicates: Candidate[]
}

/**
 * Drops agent findings that repeat an open thread (same path, line within `LINE_TOLERANCE`,
 * similar text), a deterministic finding (near and similar, or on the same line with the same
 * category) or an earlier candidate. Deterministic findings are kept over agent ones.
 */
export function dedupe(
  candidates: readonly Candidate[],
  context: { threads: readonly OpenThread[]; deterministic: readonly Candidate[] },
): DedupeResult {
  const result: DedupeResult = { kept: [], repeats: [], duplicates: [] }
  const accepted: Candidate[] = [...context.deterministic]
  for (const candidate of candidates) {
    const thread = context.threads.find(
      (t) => near(t, candidate) && similarity(t.text, textOf(candidate)) >= SIMILAR,
    )
    if (thread) {
      result.repeats.push({ candidate, thread })
      continue
    }
    const duplicate = accepted.some(
      (other) =>
        near(other, candidate) &&
        ((other.line === candidate.line && other.category === candidate.category) ||
          similarity(textOf(other), textOf(candidate)) >= SIMILAR),
    )
    if (duplicate) result.duplicates.push(candidate)
    else {
      result.kept.push(candidate)
      accepted.push(candidate)
    }
  }
  return result
}

export const severityRank = (severity: ReviewSeverity) => severities.indexOf(severity)

const categoryOrder = [
  'security',
  'bug',
  'performance',
  'tests',
  'maintainability',
  'docs',
  'style',
]

/**
 * Findings at or above `minSeverity`, most severe first (then by category, then position), at most
 * `max`. Returns the counts it left out.
 */
export function rankAndCap(
  candidates: readonly Candidate[],
  minSeverity: ReviewSeverity,
  max: number,
): { kept: Candidate[]; belowSeverity: number; overLimit: number } {
  const eligible = candidates.filter((c) => severityRank(c.severity) >= severityRank(minSeverity))
  const sorted = eligible.toSorted(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  )
  return {
    kept: sorted.slice(0, max),
    belowSeverity: candidates.length - eligible.length,
    overLimit: Math.max(0, sorted.length - max),
  }
}
