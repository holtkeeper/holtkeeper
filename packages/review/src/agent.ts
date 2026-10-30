import type { Agent, AgentResult, AgentTask, Toolset } from '@holtkeeper/agent'
import { z } from 'zod'

import type { OpenThread } from './dedupe.ts'
import { renderNumberedDiff } from './diff.ts'
import type { Guideline } from './guidelines.ts'
import { type AgentReview, type ReviewUsage, agentReviewSchema, categories } from './schema.ts'
import type { FileScope } from './scope.ts'
import type { Candidate } from './validate.ts'

/** A knowledge entry (team decision, convention, known pitfall) the review may rely on. */
export interface KnowledgeEntry {
  title: string
  body: string
}

/** Runs a task and adds its turns, cost and token counts to `usage`. */
export async function runTracked<Output>(
  agent: Agent,
  task: AgentTask<Output>,
  usage: ReviewUsage,
): Promise<AgentResult<Output>> {
  const result = await agent.run(task)
  usage.turns += result.turns
  if (result.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + result.costUsd
  if (result.usage) {
    usage.inputTokens = (usage.inputTokens ?? 0) + result.usage.inputTokens
    usage.outputTokens = (usage.outputTokens ?? 0) + result.usage.outputTokens
  }
  return result
}

export interface ReviewPromptInput {
  repo: string
  mergeRequest: { id: number; title: string; description: string }
  files: readonly FileScope[]
  mode: 'full' | 'incremental'
  previousHead?: string
  guidelines: readonly Guideline[]
  instructions?: string
  knowledge?: readonly KnowledgeEntry[]
  /** REVIEW.md path rules that match files in scope, with those files. */
  pathInstructions?: readonly { glob: string; text: string; files: readonly string[] }[]
  threads: readonly OpenThread[]
  maxComments: number
  language?: string
}

const severityGuide = [
  '- critical: security holes, data loss, crashes in common paths.',
  '- major: wrong behavior, broken edge cases, race conditions, missing error handling that will bite.',
  '- minor: maintainability problems, missing tests for new logic, misleading names, small inefficiencies.',
  '- info: optional remarks; use sparingly.',
].join('\n')

/** The system prompt: role, rules for lines and suggestions, severities, language. */
export function reviewSystemPrompt(input: ReviewPromptInput): string {
  const language = input.language
    ? `Write titles, bodies and the summary in ${input.language}.`
    : 'Write titles, bodies and the summary in the language of the merge request description (English when it has none).'
  const parts = [
    `You review merge request !${input.mergeRequest.id} of ${input.repo}. The checkout is at the merge request head; use the read and search tools to look at surrounding code, callers and tests instead of guessing.`,
    [
      'Rules:',
      '- Report only real problems the change introduces or exposes. No praise, no restating the diff, no nitpicks a formatter or linter would catch.',
      '- `line` (and `startLine` for a range) are new-side line numbers exactly as listed in the diff. Comment only on lines marked `+`; lines marked `~` were reviewed before.',
      '- A `suggestion.replacement` replaces exactly the full lines `startLine..line` (or just `line`): include their complete new text with indentation, and nothing from the lines around them. Suggest only when you are sure the replacement is correct.',
      `- At most ${input.maxComments} comments; when there are more, keep the most severe.`,
      `- Categories: ${categories.join(', ')}.`,
      '- Do not repeat open threads listed in the prompt.',
      '- verdict is `needs-changes` when any major or critical problem remains, `looks-good` otherwise.',
      '- `walkthrough`: the changes in scope grouped by logical change, most important first; each entry lists its files and says in one or two sentences what changed and why. Group related files instead of listing each one.',
      '- `effort`: how hard this change is for a human to review, 1 (trivial) to 5 (large or subtle, needs a careful look).',
      language,
    ].join('\n'),
    `Severity:\n${severityGuide}`,
  ]
  return parts.join('\n\n')
}

/**
 * The stable context block (repository guidelines, team instructions, knowledge) passed as the
 * task's `context`, so adapters can cache it across runs; empty when there is nothing.
 */
export function reviewContext(input: ReviewPromptInput): string {
  const parts: string[] = []
  if (input.guidelines.length)
    parts.push(
      `Project guidelines from the repository:\n\n${input.guidelines.map((g) => `### ${g.file}\n\n${g.text}`).join('\n\n')}`,
    )
  if (input.instructions?.trim())
    parts.push(`Review instructions from the team:\n\n${input.instructions.trim()}`)
  if (input.knowledge?.length)
    parts.push(
      `Team knowledge:\n\n${input.knowledge.map((k) => `### ${k.title}\n\n${k.body}`).join('\n\n')}`,
    )
  return parts.join('\n\n')
}

/** The task prompt: the merge request, open threads and the numbered diff of the files in scope. */
export function reviewPrompt(input: ReviewPromptInput): string {
  const description = input.mergeRequest.description.trim().slice(0, 3000)
  const diff = input.files
    .map((file) => renderNumberedDiff(file.path, file.hunks, file.lines))
    .filter(Boolean)
    .join('\n\n')
  const pathRules = (input.pathInstructions ?? []).map((rule) => {
    const files = rule.files.slice(0, 5).join(', ') + (rule.files.length > 5 ? ', ...' : '')
    return `- \`${rule.glob}\` (${files}): ${rule.text}`
  })
  const threads = input.threads.map(
    (t) => `- ${t.path}:${t.line} ${t.text.replace(/\s+/g, ' ').slice(0, 160)}`,
  )
  return [
    `# ${input.mergeRequest.title}`,
    description ? `Description:\n\n${description}` : 'The merge request has no description.',
    input.mode === 'incremental'
      ? `This is an incremental review: only lines added since ${input.previousHead?.slice(0, 12)} are marked \`+\`.`
      : '',
    pathRules.length
      ? `Rules for paths in this diff (from REVIEW.md), apply them to the matching files:\n${pathRules.join('\n')}`
      : '',
    threads.length ? `Open threads (do not repeat them):\n${threads.join('\n')}` : '',
    `Diff:\n\n${diff}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export interface AgentReviewOptions {
  agent: Agent
  dir: string
  input: ReviewPromptInput
  usage: ReviewUsage
  toolsets?: readonly Toolset[]
  maxTurns?: number
  signal?: AbortSignal
}

/** Asks the agent for a structured review; comments come back as unvalidated candidates. */
export async function runAgentReview(
  options: AgentReviewOptions,
): Promise<
  Pick<AgentReview, 'summary' | 'verdict' | 'walkthrough' | 'effort'> & { candidates: Candidate[] }
> {
  const context = reviewContext(options.input)
  const result = await runTracked(
    options.agent,
    {
      dir: options.dir,
      system: reviewSystemPrompt(options.input),
      prompt: reviewPrompt(options.input),
      ...(context ? { context } : {}),
      capabilities: ['read', 'search'],
      output: agentReviewSchema,
      taskKind: 'review',
      ...(options.toolsets ? { toolsets: options.toolsets } : {}),
      maxTurns: options.maxTurns ?? 40,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    options.usage,
  )
  const review = result.output ?? {
    comments: [],
    summary: result.text,
    verdict: 'looks-good' as const,
  }
  return {
    candidates: review.comments.map((comment) => ({ ...comment, source: 'agent' })),
    summary: review.summary,
    verdict: review.verdict,
    ...(review.walkthrough?.length ? { walkthrough: review.walkthrough } : {}),
    ...(review.effort ? { effort: review.effort } : {}),
  }
}

const recheckSchema = z.object({
  threads: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['fixed', 'still-relevant', 'unclear']),
      note: z.string(),
    }),
  ),
})

export type RecheckVerdict = z.infer<typeof recheckSchema>['threads'][number]

/**
 * Asks the cheaper triage model whether each of our earlier comments still applies to the code at
 * the current head. Threads the answer leaves out count as `unclear`.
 */
export async function recheckThreads(options: {
  agent: Agent
  dir: string
  threads: readonly { thread: OpenThread; code: string }[]
  usage: ReviewUsage
  language?: string
  toolsets?: readonly Toolset[]
  signal?: AbortSignal
}): Promise<Map<string, RecheckVerdict>> {
  if (options.threads.length === 0) return new Map()
  const items = options.threads.map(
    ({ thread, code }) =>
      `## Thread ${thread.discussionId} at ${thread.path}:${thread.line}\n\nComment:\n${thread.text}\n\nCode now:\n\`\`\`\n${code}\n\`\`\``,
  )
  const result = await runTracked(
    options.agent,
    {
      dir: options.dir,
      system: [
        'You check whether earlier code review comments were addressed. For each thread answer `fixed` when the problem is gone from the current code, `still-relevant` when it remains, `unclear` when you cannot tell. Read the files when the excerpt is not enough.',
        'note: one short sentence for the author explaining your answer.',
        options.language
          ? `Write notes in ${options.language}.`
          : 'Write notes in the language of the comment.',
      ].join('\n'),
      prompt: items.join('\n\n'),
      capabilities: ['read', 'search'],
      output: recheckSchema,
      taskKind: 'triage',
      ...(options.toolsets ? { toolsets: options.toolsets } : {}),
      maxTurns: 12,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    options.usage,
  )
  return new Map((result.output?.threads ?? []).map((verdict) => [verdict.id, verdict]))
}
