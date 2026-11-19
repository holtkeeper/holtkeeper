import { type RegistryToolset, ToolError, defineTool } from '@holtkeeper/agent-tools'
import type { ReviewData } from '@holtkeeper/review'
import { z } from 'zod'

import type { MergeRequestReviewStatus } from '../review-status.ts'

/** What `review` did about a review of the merge request's head, when one was missing. */
type ReviewRequest =
  /** It queued one. */
  | 'queued'
  /** Reviews start by themselves on new commits and this head was pushed moments ago. */
  | 'automatic'
  /** The repository is read-only for Holtkeeper. */
  | 'read-only'

/** What the `reviews` toolset reads and asks for one caller. */
export interface ReviewToolsAccess {
  /**
   * The review state of the merge request `query` names in `repo` (`forge:path`): by number, or
   * the open merge request of a source branch (else its newest one). Rejects with a `ToolError`
   * when the caller may not read the repository's analyses, Holtkeeper cannot read the merge
   * request or none matches.
   */
  status(
    repo: string,
    query: { mergeRequest?: number; branch?: string },
  ): Promise<MergeRequestReviewStatus>
  /**
   * `status`, after making sure a review of the merge request's head is coming: `request` says
   * what was done when none was queued, running or finished for it. Never queues a second review
   * of a head. Rejects like `status`.
   */
  review(
    repo: string,
    query: { mergeRequest?: number; branch?: string },
  ): Promise<{ status: MergeRequestReviewStatus; request?: ReviewRequest }>
}

/** Characters of a finding body `code_review` quotes. */
const BODY_MAX = 600

const short = (sha: string | undefined) => (sha ? sha.slice(0, 8) : 'unknown')

const verdicts: Record<ReviewData['verdict'], string> = {
  'looks-good': 'Looks good',
  'needs-changes': 'Needs changes',
  skipped: 'Not reviewed',
}

const severityRank = { critical: 0, major: 1, minor: 2, info: 3 }

const clip = (text: string) =>
  text.length > BODY_MAX ? `${text.slice(0, BODY_MAX).trimEnd()}…` : text

const place = (path: string | undefined, line: number | undefined) =>
  path ? `\`${path}${line ? `:${line}` : ''}\`` : 'general'

/** What the agent should do next, from the state; one line each. */
function nextSteps(status: MergeRequestReviewStatus, request?: ReviewRequest): string[] {
  const { mergeRequest: mr, runs, active, failed, off, openThreads } = status
  if (off)
    return [
      `Holtkeeper does not review merge requests of this repository${off.reason ? `: ${off.reason}` : ''}.`,
    ]
  if (mr.state !== 'open')
    return [`The merge request is ${mr.state}; nothing more will be reviewed.`]
  const again = 'call code_review again in a few minutes for the findings'
  const steps: string[] = []
  const latest = runs[0]?.data
  if (request === 'queued')
    steps.push(
      `${failed ? `The last review job ${failed.status === 'blocked' ? 'was stopped by the AI budget' : failed.status}${failed.error ? ` (${failed.error})` : ''}. ` : ''}A review of ${short(mr.headSha)} was queued just now; ${again}.`,
    )
  else if (request === 'automatic')
    steps.push(
      `Reviews start by themselves on new commits and one for ${short(mr.headSha)} is on its way; ${again}.`,
    )
  else if (request === 'read-only')
    steps.push(
      'The repository is frozen for Holtkeeper, so no review was queued; a maintainer can lift the freeze in Settings.',
    )
  else if (active) steps.push(`A review is ${active.status} for ${short(active.ref)}; ${again}.`)
  else if (!latest) steps.push('No review yet and none could be queued: the head is unknown.')
  if (openThreads?.length)
    steps.push(
      'Fix the open threads or answer them on the merge request, push, and call code_review again: the next review re-checks them and resolves the fixed ones.',
    )
  else if (latest?.verdict === 'looks-good' && !active && !request)
    steps.push('Nothing left to fix.')
  return steps
}

/** The Markdown answer of `code_review`. */
function renderReviewStatus(status: MergeRequestReviewStatus, request?: ReviewRequest): string {
  const { repo, mergeRequest: mr, runs, openThreads } = status
  const lines = [
    `## ${repo.forge}:${repo.path}!${mr.id} ${mr.title}`,
    `${mr.state}${mr.draft ? ', draft' : ''} · \`${mr.sourceBranch}\` → \`${mr.targetBranch}\` · head ${short(mr.headSha)} · ${mr.webUrl}`,
  ]
  const latest = runs[0]
  if (latest) {
    const { data } = latest
    lines.push(
      '',
      `**Review: ${verdicts[data.verdict]}** (${data.mode}, ${latest.createdAt}, reviewed ${short(data.head)}${mr.headSha && data.head !== mr.headSha ? ', older than the head' : ''})`,
    )
    if (data.summary.trim()) lines.push('', data.summary.trim())
    const posted = data.comments
      .filter((finding) => finding.posted)
      .toSorted((a, b) => severityRank[a.severity] - severityRank[b.severity])
    if (posted.length) {
      lines.push('', `### Findings of this run (${posted.length})`)
      for (const finding of posted)
        lines.push(
          `- **${finding.severity}** · ${finding.category} · ${place(finding.path, finding.line)} — **${finding.title}**${finding.suggestion ? ' (has a suggestion)' : ''}`,
          `  ${clip(finding.body.trim()).replaceAll('\n', '\n  ')}`,
        )
    }
    if (data.threads.length) {
      lines.push('', '### Earlier threads re-checked in this run')
      for (const thread of data.threads)
        lines.push(
          `- ${thread.action === 'resolved' ? 'Resolved' : 'Still applies'} · ${place(thread.path, thread.line)}: ${thread.reason}`,
        )
    }
  } else lines.push('', '**Review:** none yet')

  if (openThreads) {
    lines.push('', `### Open Holtkeeper threads (${openThreads.length})`)
    if (!openThreads.length) lines.push('None.')
    for (const thread of openThreads)
      lines.push(
        `- ${thread.severity ? `**${thread.severity}** · ` : ''}${thread.category ?? ''} · ${place(thread.path, thread.line)} — ${thread.title}${thread.replies ? ` (${thread.replies} ${thread.replies === 1 ? 'reply' : 'replies'})` : ''}`,
      )
  }

  if (runs.length > 1) {
    lines.push('', '### Earlier runs')
    for (const run of runs.slice(1))
      lines.push(
        `- ${run.createdAt} · ${run.data.mode} · ${short(run.data.head)} · ${verdicts[run.data.verdict]} · ${run.data.comments.filter((finding) => finding.posted).length} findings, ${run.data.threads.filter((thread) => thread.action === 'resolved').length} threads resolved`,
      )
  }

  const steps = nextSteps(status, request)
  if (steps.length) lines.push('', '### Next', ...steps.map((step) => `- ${step}`))
  return lines.join('\n')
}

/** Name of the tool of the `reviews` toolset. */
export const CODE_REVIEW_TOOL = 'code_review'

/**
 * The `reviews` toolset: `code_review` asks for Holtkeeper's review of a merge request (by number
 * or source branch) and tells how it stands: verdict, findings, open threads, earlier runs, a
 * review that is queued, running or failed, and what to do next. It queues a review only when
 * none covers the head (`ReviewToolsAccess.review`), so it is safe to call repeatedly.
 */
export function reviewsToolset(access: ReviewToolsAccess): RegistryToolset {
  return {
    name: 'reviews',
    instructions:
      'After you push a branch or open a merge request, offer the user a Holtkeeper code review: call code_review with the repository and branch, call it again a few minutes later for the findings, then go through them with the user and fix what is right.',
    tools: [
      defineTool({
        name: CODE_REVIEW_TOOL,
        description:
          "Asks for Holtkeeper's code review of a merge request and reports how it stands; one call does both, so call it after a push and again a few minutes later. Pass the repository and the source branch (or the merge request number). It needs a merge request: without one it says to open it. If no review covers the newest commit it makes sure one is coming (it never starts a second one, and leaves it to the automatic review where that is on), then returns the verdict and summary of the newest run, its findings with file and line, unresolved Holtkeeper threads, which earlier threads were resolved, earlier runs and what to do next. It also says when Holtkeeper has no access to the merge request or reviews are off.",
        input: z.object({
          repo: z.string().min(3).describe('The repository, as forge:path'),
          branch: z.string().min(1).optional().describe('The source branch of the merge request'),
          mergeRequest: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('The merge request number (iid); instead of branch'),
        }),
        readOnly: false,
        run: async ({ repo, branch, mergeRequest }) => {
          if (branch === undefined && mergeRequest === undefined)
            throw new ToolError('Pass branch or mergeRequest.')
          const { status, request } = await access.review(repo, {
            ...(branch !== undefined && { branch }),
            ...(mergeRequest !== undefined && { mergeRequest }),
          })
          return renderReviewStatus(status, request)
        },
        subject: ({ repo }) => repo,
      }),
    ],
  }
}
