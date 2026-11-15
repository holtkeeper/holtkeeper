import type { GitForge, ReviewSubmission } from '@holtkeeper/forge'

import { LINE_TOLERANCE, SIMILAR, similarity } from './dedupe.ts'
import { type ReviewRun, reviewMergeRequest } from './pipeline.ts'
import type { ReviewData, ReviewFinding } from './schema.ts'

/** What a review would have changed on the forge, collected by `dryRunForge`. */
export interface WouldHaveDone {
  /** Reviews with their inline comments and summary. */
  submissions: ReviewSubmission[]
  /** Replies to threads. */
  replies: { discussionId: string; body: string }[]
  /** Threads it would have resolved. */
  resolved: string[]
}

/** Methods a dry run may call on the real forge; everything else is a write and throws. */
const READS = new Set<string | symbol>([
  'kind',
  'getRepository',
  'getMergeRequest',
  'getMergeRequestDiff',
  'listDiscussions',
  'listNoteReactions',
  'listFiles',
  'compareCommits',
  'readFile',
  'readFileBytes',
  'getCurrentUser',
  'headCommit',
])

/**
 * A view of `forge` for running a review without changing anything: reads go to the real forge,
 * the review, thread replies and resolving the review would have made are collected in `wouldDo`
 * (a submitted review counts as fully posted), and any other method throws, so a step added to
 * the pipeline later cannot write by accident.
 */
export function dryRunForge<Forge extends GitForge>(
  forge: Forge,
): { forge: Forge; wouldDo: WouldHaveDone } {
  const wouldDo: WouldHaveDone = { submissions: [], replies: [], resolved: [] }
  const writes: Record<string, (...args: never[]) => Promise<unknown>> = {
    submitReview: async (_repo: string, _id: number, review: ReviewSubmission) => {
      wouldDo.submissions.push(review)
      return { posted: review.comments.length, failed: [] }
    },
    replyToDiscussion: async (_repo: string, _id: number, discussionId: string, body: string) => {
      wouldDo.replies.push({ discussionId, body })
    },
    resolveDiscussion: async (_repo: string, _id: number, discussionId: string) => {
      wouldDo.resolved.push(discussionId)
    },
  }
  const view = new Proxy(forge, {
    get(target, property) {
      const write = typeof property === 'string' ? writes[property] : undefined
      if (write && property in target) return write
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (READS.has(property)) return (...args: unknown[]) => Reflect.apply(value, target, args)
      return () => {
        throw new Error(`dry run: forge.${String(property)} would change the forge`)
      }
    },
  })
  return { forge: view, wouldDo }
}

/**
 * Runs the whole review of `run` against the real forge, checkout and agent without posting,
 * replying or resolving anything, and without reading or storing analyses unless `run.analyses`
 * is given (leave it out to compare strategies on the same, full diff). Returns the data the run
 * would have stored and what it would have changed on the forge.
 */
export async function shadowReview(
  run: ReviewRun,
): Promise<{ data: ReviewData; wouldDo: WouldHaveDone }> {
  const { forge, wouldDo } = dryRunForge(run.forge)
  const data = await reviewMergeRequest({ ...run, forge })
  return { data, wouldDo }
}

/** Two findings that point at the same problem: same file, nearby lines, alike or same category. */
function sameProblem(a: ReviewFinding, b: ReviewFinding): boolean {
  if (a.path !== b.path || Math.abs(a.line - b.line) > LINE_TOLERANCE) return false
  if (a.line === b.line && a.category === b.category) return true
  return similarity(`${a.title}\n${a.body}`, `${b.title}\n${b.body}`) >= SIMILAR
}

/** What two review runs of the same merge request have in common. */
export interface ReviewComparison {
  /** Findings both runs reported, paired. */
  both: { a: ReviewFinding; b: ReviewFinding }[]
  /** Only in the first run. */
  onlyA: ReviewFinding[]
  /** Only in the second run. */
  onlyB: ReviewFinding[]
  verdict: { a: ReviewData['verdict']; b: ReviewData['verdict'] }
  /** `b` minus `a`; absent when a run reported no cost. */
  costUsd?: number
  turns?: number
}

/**
 * Compares the posted findings of two runs: pairs those that point at the same problem (same
 * file, lines at most `LINE_TOLERANCE` apart, and the same category on the same line or alike
 * text), one to one, and lists what only one of them found. Says nothing about which is right;
 * a person reads `onlyA` and `onlyB`.
 */
export function compareReviews(a: ReviewData, b: ReviewData): ReviewComparison {
  const left = a.comments.filter((finding) => finding.posted)
  const right = b.comments.filter((finding) => finding.posted)
  const taken = new Set<ReviewFinding>()
  const both: ReviewComparison['both'] = []
  const onlyA: ReviewFinding[] = []
  for (const finding of left) {
    const other = right.find(
      (candidate) => !taken.has(candidate) && sameProblem(finding, candidate),
    )
    if (other) {
      taken.add(other)
      both.push({ a: finding, b: other })
    } else onlyA.push(finding)
  }
  return {
    both,
    onlyA,
    onlyB: right.filter((finding) => !taken.has(finding)),
    verdict: { a: a.verdict, b: b.verdict },
    ...(a.usage?.costUsd !== undefined && b.usage?.costUsd !== undefined
      ? { costUsd: b.usage.costUsd - a.usage.costUsd }
      : {}),
    ...(a.usage && b.usage ? { turns: b.usage.turns - a.usage.turns } : {}),
  }
}
