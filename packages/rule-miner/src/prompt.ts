import { z } from 'zod'

import type { ReviewComment } from './evidence.ts'

/** Bumped whenever the prompt or the output handling changes; stored with every run. */
export const MINER_VERSION = 1

/** The system prompt of a rule miner call. */
export const MINER_SYSTEM = [
  'You turn code review comments into short coding rules for one repository, the way a senior teammate would summarise what reviewers keep asking for.',
  'Every comment below led to a change: the commented lines changed afterwards, the author confirmed the fix, or the thread was resolved.',
  'Rules:',
  '- A rule is one imperative sentence of at most about 25 words ("Wrap outbound HTTP calls in the shared retry helper."), specific enough that a reviewer could check it on a diff.',
  '- Every rule follows from the comments and cites the ids of every comment that supports it in `comments`.',
  '- Prefer rules that several comments, ideally across different merge requests, support; a rule backed by one comment must be a clear, reusable convention.',
  '- Skip one-off fixes, typos, questions, praise and generic advice ("write tests", "keep functions small", "add comments").',
  '- Skip rules an existing learning already states.',
  '- People are named by role only; never put names, usernames or merge request numbers in a rule.',
  '- `reason`, optional, says in one short sentence why the rule holds, from the comments.',
  'Answer with JSON only: {"rules": [{"text", "reason"?, "comments": ["c1", ...]}]}.',
].join('\n')

/** The task context of a rule miner call, so the server adds no rules block of its own. */
export const MINER_CONTEXT =
  'Rule miner: the review comments and the existing learnings follow in the prompt.'

/** The model's answer: rules with the comment ids that support them. */
export const minerOutput = z.object({
  rules: z
    .array(
      z.object({
        text: z.string().trim().min(8).max(300),
        reason: z.string().trim().max(400).optional(),
        comments: z.array(z.string()).min(1).max(30),
      }),
    )
    .max(20),
})

export type MinerOutput = z.output<typeof minerOutput>

/** Everything the user prompt of a run holds. */
export interface MinerPromptInput {
  /** `forge:path`. */
  repo: string
  /** How far back merge requests were read (a date). */
  since: string
  maxRules: number
  comments: readonly ReviewComment[]
  /** Texts of the learnings that already apply to the repository. */
  existing: readonly string[]
  /** One-off extra request of the run. */
  extra?: string
}

/** Most characters of the existing learnings block. */
export const EXISTING_CHARS = 6_000

const signalWords = {
  changed: 'lines changed after the comment',
  acknowledged: 'author confirmed the change',
  resolved: 'thread resolved',
} as const

/** The user prompt of a rule miner call. */
export function minerPrompt(input: MinerPromptInput): string {
  let existingChars = 0
  const existing = input.existing.flatMap((text) => {
    const line = `- ${text.replaceAll(/\s+/g, ' ')}`
    if (existingChars + line.length > EXISTING_CHARS) return []
    existingChars += line.length
    return [line]
  })
  return [
    `Repository: ${input.repo}`,
    `Write at most ${input.maxRules} rules, best supported first; fewer when the comments are thin, none when they show nothing reusable. The comments come from merge requests merged since ${input.since}.`,
    '# Review comments',
    ...input.comments.map(
      (comment) =>
        `## [${comment.id}] !${comment.mergeRequest.id} (${signalWords[comment.signal]})\n${comment.text}`,
    ),
    existing.length
      ? `# Existing learnings\n${existing.join('\n')}`
      : '# Existing learnings\nNone.',
    input.extra?.trim() ? `# Extra request for this run\n${input.extra.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
