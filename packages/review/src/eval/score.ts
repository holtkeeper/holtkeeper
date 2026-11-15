import { severityRank } from '../dedupe.ts'
import type { ReviewFinding, ReviewUsage } from '../schema.ts'
import type { EvalCase, ExpectedFinding } from './case.ts'

/** How many lines beside the expected ones a comment may sit and still count. */
export const LINE_SLACK = 2

/** A review comment as scoring needs it. */
export type ScoredInput = Pick<
  ReviewFinding,
  'path' | 'line' | 'startLine' | 'severity' | 'category' | 'title' | 'body'
>

/** A comment with the expected problem it was matched to, if any. */
export interface ScoredComment {
  path: string
  line: number
  startLine?: number
  severity: ReviewFinding['severity']
  category: ReviewFinding['category']
  title: string
  /** Id of the expected problem it points at; absent for a comment on nothing expected. */
  matched?: string
  /** It points at a problem an earlier comment already found. */
  duplicate?: true
}

/** How one review of one case went. */
export interface CaseScore {
  caseId: string
  comments: ScoredComment[]
  /** Ids of the expected problems some comment found. */
  found: string[]
  /** Ids of the expected problems no comment found. */
  missed: string[]
  /** Found problems the review rated below the expected `minSeverity`. */
  underrated: string[]
  /** Comments on nothing expected, not counting duplicates. */
  falsePositives: number
  duplicates: number
}

const overlaps = (expected: ExpectedFinding, comment: ScoredInput) => {
  const from = comment.startLine ?? comment.line
  return comment.line >= expected.lines[0] - LINE_SLACK && from <= expected.lines[1] + LINE_SLACK
}

const mentioned = (expected: ExpectedFinding, comment: ScoredInput) => {
  if (!expected.mentions?.length) return true
  const text = `${comment.title}\n${comment.body}`.toLowerCase()
  return expected.mentions.some((words) => words.every((word) => text.includes(word.toLowerCase())))
}

const points = (expected: ExpectedFinding, comment: ScoredInput) =>
  expected.path === comment.path &&
  overlaps(expected, comment) &&
  mentioned(expected, comment) &&
  (!expected.categories || expected.categories.includes(comment.category))

/**
 * Scores the comments of a review of `testCase`: a comment points at an expected problem when it
 * is on the same file, overlaps its lines (give or take `LINE_SLACK`), mentions what the expected
 * problem asks for and is filed under an accepted category. Comments go in order; each takes the
 * first matching problem nobody found yet, and a comment that only matches found problems is a
 * duplicate. Everything else is a false positive, so an incomplete `expected` list lowers
 * precision rather than hiding noise.
 */
export function scoreCase(testCase: EvalCase, comments: readonly ScoredInput[]): CaseScore {
  const best = new Map<string, ScoredInput['severity']>()
  const scored = comments.map((comment): ScoredComment => {
    const base = {
      path: comment.path,
      line: comment.line,
      ...(comment.startLine ? { startLine: comment.startLine } : {}),
      severity: comment.severity,
      category: comment.category,
      title: comment.title,
    }
    const matching = testCase.expected.filter((expected) => points(expected, comment))
    const target = matching.find((expected) => !best.has(expected.id)) ?? matching[0]
    if (!target) return base
    const known = best.get(target.id)
    if (!known || severityRank(comment.severity) > severityRank(known))
      best.set(target.id, comment.severity)
    return known
      ? { ...base, matched: target.id, duplicate: true }
      : { ...base, matched: target.id }
  })
  return {
    caseId: testCase.id,
    comments: scored,
    found: testCase.expected.filter((e) => best.has(e.id)).map((e) => e.id),
    missed: testCase.expected.filter((e) => !best.has(e.id)).map((e) => e.id),
    underrated: testCase.expected.flatMap((expected) => {
      const severity = best.get(expected.id)
      return severity &&
        expected.minSeverity &&
        severityRank(severity) < severityRank(expected.minSeverity)
        ? [expected.id]
        : []
    }),
    falsePositives: scored.filter((comment) => !comment.matched).length,
    duplicates: scored.filter((comment) => comment.duplicate).length,
  }
}

/** The outcome of one run of one case: its score and what the run used, or why it failed. */
export interface CaseResult {
  caseId: string
  /** 1-based number of the repetition. */
  run: number
  score: CaseScore
  /** The review's verdict; absent when the run failed. */
  verdict?: 'looks-good' | 'needs-changes' | 'skipped'
  usage?: ReviewUsage
  durationMs?: number
  /** The run failed with this; its score then counts every expected problem as missed. */
  error?: string
  /** How many problems the case expects, so a summary needs no cases. */
  expected: number
}

/** Quality and cost of a set of runs. */
export interface EvalSummary {
  /** Runs counted (cases times repetitions). */
  runs: number
  /** Runs that failed. */
  errors: number
  /** Expected problems over all runs. */
  expected: number
  found: number
  /** Comments posted over all runs, and how many pointed at an expected problem. */
  comments: number
  matched: number
  falsePositives: number
  duplicates: number
  underrated: number
  /** Runs of cases that expect nothing, and how many of those still drew a comment. */
  cleanRuns: number
  cleanFlagged: number
  /** Share of comments on expected problems; 1 without comments. */
  precision: number
  /** Share of expected problems found; 1 when none is expected. */
  recall: number
  f1: number
  costUsd: number
  turns: number
  durationMs: number
}

const ratio = (part: number, whole: number) => (whole === 0 ? 1 : part / whole)

/** Sums `results` into one summary; precision and recall are over all runs together. */
export function summarize(results: readonly CaseResult[]): EvalSummary {
  const sum = (pick: (result: CaseResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0)
  const expected = sum((r) => r.expected)
  const found = sum((r) => r.score.found.length)
  const comments = sum((r) => r.score.comments.length)
  const matched = sum((r) => r.score.comments.filter((c) => c.matched).length)
  const precision = ratio(matched, comments)
  const recall = ratio(found, expected)
  const clean = results.filter((result) => result.expected === 0 && !result.error)
  return {
    runs: results.length,
    errors: results.filter((r) => r.error).length,
    expected,
    found,
    comments,
    matched,
    falsePositives: sum((r) => r.score.falsePositives),
    duplicates: sum((r) => r.score.duplicates),
    underrated: sum((r) => r.score.underrated.length),
    cleanRuns: clean.length,
    cleanFlagged: clean.filter((r) => r.score.comments.length > 0).length,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    costUsd: sum((r) => r.usage?.costUsd ?? 0),
    turns: sum((r) => r.usage?.turns ?? 0),
    durationMs: sum((r) => r.durationMs ?? 0),
  }
}
