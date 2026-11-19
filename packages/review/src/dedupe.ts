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
  /** The latest note when a person left it after ours in a thread we started: a reply waiting for an answer. */
  reply?: { noteId: number | string; author: string; text: string }
}

/** Whether Holtkeeper's review wrote the note: it carries the review marker or the bot wrote it. */
export const isOurNote = (note: { author: string; body: string }, botUsername?: string) =>
  markerOf(note.body) !== undefined || (botUsername !== undefined && note.author === botUsername)

const withoutComments = (body: string) => body.replace(/<!--[\s\S]*?-->/g, '').trim()

/** Unresolved threads on diff lines; `ours` is decided by the marker or the bot's username. */
export function openThreads(
  discussions: readonly Discussion[],
  botUsername?: string,
): OpenThread[] {
  return discussions.flatMap((discussion): OpenThread[] => {
    const first = discussion.notes.find((note) => !note.system)
    if (!discussion.position || discussion.resolved || !first) return []
    const marker = markerOf(first.body)
    const ours = marker !== undefined || (botUsername !== undefined && first.author === botUsername)
    const last = discussion.notes.findLast((note) => !note.system)
    const reply = ours && last && last !== first && !isOurNote(last, botUsername) ? last : undefined
    return [
      {
        discussionId: discussion.id,
        path: discussion.position.path,
        line: discussion.position.line,
        text: first.body.replace(new RegExp(markerPattern.source, 'g'), '').trim(),
        ours,
        ...(marker ? { findingId: marker } : {}),
        ...(reply && {
          reply: { noteId: reply.id, author: reply.author, text: withoutComments(reply.body) },
        }),
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

/** How many lines apart two comments about the same code (`sameCode`) may be and still be the same. */
export const CODE_LINE_TOLERANCE = 15

const codeSpansOf = (text: string) =>
  new Set(
    [...text.replace(/```[\s\S]*?```/g, ' ').matchAll(/`([^`\n]+)`/g)]
      .map((match) => match[1]?.trim() ?? '')
      .filter((span) => span.length >= 2),
  )

/**
 * Whether two comments name mostly the same code: at least three shared inline code spans, making
 * up at least half of the shorter comment's spans. Rephrasings in an inflected language share few
 * words but keep the identifiers.
 */
export function sameCode(a: string, b: string): boolean {
  const left = codeSpansOf(a)
  const right = codeSpansOf(b)
  let shared = 0
  for (const span of left) if (right.has(span)) shared++
  return shared >= 3 && shared / Math.min(left.size, right.size) >= 0.5
}

const textOf = (candidate: Pick<Candidate, 'title' | 'body'>) =>
  `${candidate.title}\n${candidate.body}`

const near = (a: { path: string; line: number }, b: { path: string; line: number }) =>
  a.path === b.path && Math.abs(a.line - b.line) <= LINE_TOLERANCE

const nearSameCode = (
  a: { path: string; line: number },
  b: { path: string; line: number },
  textA: string,
  textB: string,
) => a.path === b.path && Math.abs(a.line - b.line) <= CODE_LINE_TOLERANCE && sameCode(textA, textB)

/**
 * Whether two findings report the same problem: near (`LINE_TOLERANCE`) and on the same line with
 * the same category or with a similar text, or within `CODE_LINE_TOLERANCE` lines and about the
 * same code (`sameCode`).
 */
export function sameFinding(
  a: Pick<Candidate, 'path' | 'line' | 'category' | 'title' | 'body'>,
  b: Pick<Candidate, 'path' | 'line' | 'category' | 'title' | 'body'>,
): boolean {
  return (
    (near(a, b) &&
      ((a.line === b.line && a.category === b.category) ||
        similarity(textOf(a), textOf(b)) >= SIMILAR)) ||
    nearSameCode(a, b, textOf(a), textOf(b))
  )
}

export interface DedupeResult {
  kept: Candidate[]
  /** Candidates that repeat an open thread; `thread.ours` ones may deserve a reply instead. */
  repeats: { candidate: Candidate; thread: OpenThread }[]
  /** Candidates that repeat a deterministic finding or an earlier candidate. */
  duplicates: Candidate[]
}

/**
 * Drops agent findings that repeat an open thread (same path, line within `LINE_TOLERANCE` and a
 * similar text, or within `CODE_LINE_TOLERANCE` and about the same code), a deterministic finding
 * or an earlier candidate (`sameFinding`). Deterministic findings are kept over agent ones.
 */
export function dedupe(
  candidates: readonly Candidate[],
  context: { threads: readonly OpenThread[]; deterministic: readonly Candidate[] },
): DedupeResult {
  const result: DedupeResult = { kept: [], repeats: [], duplicates: [] }
  const accepted: Candidate[] = [...context.deterministic]
  for (const candidate of candidates) {
    const text = textOf(candidate)
    const thread = context.threads.find(
      (t) =>
        (near(t, candidate) && similarity(t.text, text) >= SIMILAR) ||
        nearSameCode(t, candidate, t.text, text),
    )
    if (thread) {
      result.repeats.push({ candidate, thread })
      continue
    }
    const duplicate = accepted.some((other) => sameFinding(other, candidate))
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
  'maintainability',
  'tests',
  'docs',
  'style',
]

/** Categories about what the program does, as opposed to how its code reads or is tested. */
const behaviorCategories = new Set(['security', 'bug', 'performance'])

/**
 * Rank of a finding for the comment limit: by severity, and below `major` a finding about
 * behavior before one of the same severity about tests, maintainability, docs or style.
 */
const limitRank = (c: Candidate) =>
  severityRank(c.severity) * 2 +
  (behaviorCategories.has(c.category) || severityRank(c.severity) >= severityRank('major') ? 1 : 0)

/**
 * Findings at or above `minSeverity`, most important first, at most `max`: by severity, below
 * `major` behavior (security, bug, performance) before tests, maintainability, docs and style,
 * then by category and position. Returns the counts it left out.
 */
export function rankAndCap(
  candidates: readonly Candidate[],
  minSeverity: ReviewSeverity,
  max: number,
): { kept: Candidate[]; belowSeverity: number; overLimit: number } {
  const eligible = candidates.filter((c) => severityRank(c.severity) >= severityRank(minSeverity))
  const sorted = eligible.toSorted(
    (a, b) =>
      limitRank(b) - limitRank(a) ||
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
