import { type RegistryToolset, ToolError, defineTool } from '@holtkeeper/agent-tools'
import type { ReviewData } from '@holtkeeper/review'
import { z } from 'zod'

import type { MergeRequestReviewStatus } from '../review-status.ts'

/** What the `reviews` toolset reads for one caller. */
export interface ReviewToolsAccess {
  /**
   * The review state of the merge request `query` names in `repo` (`forge:path`): by number, or
   * the open merge request of a source branch (else its newest one). Rejects with a `ToolError`
   * when the caller may not read the repository's analyses or no merge request matches.
   */
  status(
    repo: string,
    query: { mergeRequest?: number; branch?: string },
  ): Promise<MergeRequestReviewStatus>
}

/** Characters of a finding body `review_status` quotes. */
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
function nextSteps(status: MergeRequestReviewStatus): string[] {
  const { mergeRequest: mr, runs, active, failed, off, automatic, openThreads } = status
  if (off)
    return [
      `Holtkeeper does not review merge requests of this repository${off.reason ? `: ${off.reason}` : ''}.`,
    ]
  if (mr.state !== 'open')
    return [`The merge request is ${mr.state}; nothing more will be reviewed.`]
  const ask = 'comment `/holtkeeper review` on the merge request to ask for one'
  const steps: string[] = []
  const latest = runs[0]?.data
  if (active)
    steps.push(
      `A review is ${active.status} for ${short(active.ref)}; call review_status again in a few minutes.`,
    )
  else if (failed && (!latest || failed.at > runs[0]!.createdAt))
    steps.push(
      `The last review job ${failed.status === 'blocked' ? 'was stopped by the AI budget' : failed.status}${failed.error ? ` (${failed.error})` : ''}; ${ask} again.`,
    )
  else if (!latest)
    steps.push(
      automatic.enabled
        ? 'No review yet; one starts on the next push.'
        : `No review yet: ${automatic.reason}; ${ask}.`,
    )
  else if (mr.headSha && latest.head !== mr.headSha)
    steps.push(
      automatic.enabled
        ? `New commits since the reviewed ${short(latest.head)} and no review is queued for them; ${ask}.`
        : `New commits since the reviewed ${short(latest.head)}, not reviewed because ${automatic.reason}; ${ask}.`,
    )
  if (openThreads?.length)
    steps.push(
      'Fix the open threads or answer them on the merge request; after the push the next review re-checks them and resolves the fixed ones.',
    )
  else if (latest?.verdict === 'looks-good' && !active) steps.push('Nothing left to fix.')
  return steps
}

/** The Markdown answer of `review_status`. */
function renderReviewStatus(status: MergeRequestReviewStatus): string {
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

  const steps = nextSteps(status)
  if (steps.length) lines.push('', '### Next', ...steps.map((step) => `- ${step}`))
  return lines.join('\n')
}

/**
 * The `reviews` toolset: `review_status` tells a developer's agent how Holtkeeper's review of a
 * merge request stands (by number or source branch): verdict, findings, open threads, earlier
 * runs, a review that is queued, running or failed, and what to do next. Read-only.
 */
export function reviewsToolset(access: ReviewToolsAccess): RegistryToolset {
  return {
    name: 'reviews',
    instructions:
      'After pushing a branch with a merge request, call review_status with the repository and branch to read Holtkeeper’s review: what to fix, which threads are still open, and whether a new review is coming.',
    tools: [
      defineTool({
        name: 'review_status',
        description:
          "Holtkeeper's review of a merge request, found by source branch or number: the verdict and summary of the newest run, its findings with file and line, unresolved Holtkeeper threads, which earlier threads the run resolved, earlier runs, a review that is queued, running or failed, and what to do next. Call it again after pushing fixes.",
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
        run: async ({ repo, branch, mergeRequest }) => {
          if (branch === undefined && mergeRequest === undefined)
            throw new ToolError('Pass branch or mergeRequest.')
          return renderReviewStatus(
            await access.status(repo, {
              ...(branch !== undefined && { branch }),
              ...(mergeRequest !== undefined && { mergeRequest }),
            }),
          )
        },
        subject: ({ repo }) => repo,
      }),
    ],
  }
}
