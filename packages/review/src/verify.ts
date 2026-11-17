import { resolve, sep } from 'node:path'

import type { Agent, Toolset } from '@holtkeeper/agent'
import { z } from 'zod'

import { KEEP_ENGLISH, runTracked } from './agent.ts'
import { severityRank } from './dedupe.ts'
import type { Evidence, ReviewUsage } from './schema.ts'
import type { Candidate } from './validate.ts'

const verdictSchema = z.object({
  findings: z.array(
    z.object({
      id: z.number().int(),
      verdict: z.enum(['confirmed', 'refuted', 'uncertain']),
      reason: z.string(),
    }),
  ),
})

/** An agent finding the verification pass showed wrong, with its reason. */
export interface RefutedFinding {
  candidate: Candidate
  reason: string
}

/** What `verifyFindings` kept and dropped. */
export interface Verification {
  /** The input findings that stay, in input order. */
  kept: Candidate[]
  refuted: RefutedFinding[]
  /** Groups whose verification failed; their findings are all kept. */
  failed: number
}

/** Turn limit of a verification task: a base plus a few turns per finding. */
export const verifyTurns = (findings: number) => Math.min(50, 10 + findings * 4)

const SYSTEM = [
  'You are the second reviewer of a merge request. Another reviewer wrote the findings below; most are right, some rest on a wrong reading of code outside the diff. The checkout is at the merge request head.',
  'For each finding, try to disprove it: read the code it is about and the code its premise depends on with the tools — callers, guards before the line, other methods that read or write the same value, the tests of the changed code (they may be added by this very merge request), the commit history when the finding is about what changed. The cited evidence is a starting point, not proof.',
  'Answer per finding:',
  '- `refuted`: the code shows the claim is wrong (the guard exists, the value is reset elsewhere, the tests exist, the fix would break a caller that relies on the current behavior, the case cannot happen). The reason names where (path:line).',
  '- `confirmed`: you checked the premise and it holds. A remark that is a matter of taste is confirmed unless its factual premise is wrong.',
  '- `uncertain`: you could not tell either way.',
  'Answer for every finding, keeping its id. The reason is one or two sentences.',
  KEEP_ENGLISH,
].join('\n')

const describe = (candidate: Candidate, id: number) =>
  [
    `## Finding ${id}: ${candidate.path}:${candidate.startLine ? `${candidate.startLine}-` : ''}${candidate.line} (${candidate.severity}, ${candidate.category})`,
    `Title: ${candidate.title}`,
    candidate.body,
    candidate.suggestion
      ? `Suggested replacement:\n\`\`\`\n${candidate.suggestion.replacement}\n\`\`\``
      : '',
    candidate.evidence?.length
      ? `Evidence cited:\n${candidate.evidence
          .map((e) => `- ${e.path}${e.line ? `:${e.line}` : ''}${e.note ? ` — ${e.note}` : ''}`)
          .join('\n')}`
      : 'No evidence cited.',
  ]
    .filter(Boolean)
    .join('\n\n')

const isBudgetStop = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'BudgetExceededError' || isBudgetStop(error.cause))

/**
 * Lets a skeptical second pass try to disprove the agent's findings with the tools and drops the
 * ones it refutes; confirmed, uncertain and unanswered findings stay. Findings from checks (any
 * `source` but `agent`) are never sent and always stay. Major and critical findings are checked on
 * the `deep` tier, the rest on `main` (on `deep` with `deep`), each group in one task of kind
 * `review-verify`, both at once. A group whose task fails keeps all its findings and counts in
 * `failed`; an abort is rethrown, a spend limit is not (the review goes on unverified).
 */
export async function verifyFindings(options: {
  agent: Agent
  dir: string
  candidates: readonly Candidate[]
  usage: ReviewUsage
  mergeRequest: { title: string; description: string }
  deep?: boolean
  toolsets?: readonly Toolset[]
  signal?: AbortSignal
  log?: (line: string) => void
}): Promise<Verification> {
  const indexed = options.candidates.map((candidate, id) => ({ candidate, id }))
  const agentFindings = indexed.filter(({ candidate }) => candidate.source === 'agent')
  if (!agentFindings.length) return { kept: [...options.candidates], refuted: [], failed: 0 }
  const serious = agentFindings.filter(
    ({ candidate }) => severityRank(candidate.severity) >= severityRank('major'),
  )
  const rest = agentFindings.filter((finding) => !serious.includes(finding))
  const groups = [
    { findings: serious, deep: true },
    { findings: rest, deep: options.deep === true },
  ].filter((group) => group.findings.length)

  const refutedIds = new Map<number, string>()
  let failed = 0
  await Promise.all(
    groups.map(async (group) => {
      try {
        const result = await runTracked(
          options.agent,
          {
            dir: options.dir,
            system: SYSTEM,
            prompt: [
              `# ${options.mergeRequest.title}`,
              options.mergeRequest.description.trim().slice(0, 1500),
              ...group.findings.map(({ candidate, id }) => describe(candidate, id)),
            ]
              .filter(Boolean)
              .join('\n\n'),
            capabilities: ['read', 'search'],
            output: verdictSchema,
            taskKind: 'review-verify',
            tier: group.deep ? 'deep' : 'main',
            ...(options.toolsets ? { toolsets: options.toolsets } : {}),
            maxTurns: verifyTurns(group.findings.length),
            ...(options.signal ? { signal: options.signal } : {}),
          },
          options.usage,
        )
        const ids = new Set(group.findings.map(({ id }) => id))
        for (const answer of result.output?.findings ?? [])
          if (answer.verdict === 'refuted' && ids.has(answer.id))
            refutedIds.set(answer.id, answer.reason.trim())
      } catch (error) {
        options.signal?.throwIfAborted()
        failed++
        options.log?.(
          `verification ${isBudgetStop(error) ? 'stopped by a spend limit' : 'failed'}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }),
  )
  return {
    kept: indexed.filter(({ id }) => !refutedIds.has(id)).map(({ candidate }) => candidate),
    refuted: indexed.flatMap(({ candidate, id }) => {
      const reason = refutedIds.get(id)
      return reason === undefined ? [] : [{ candidate, reason }]
    }),
    failed,
  }
}

/**
 * The entries of `evidence` whose path is a file inside `dir`; a cited path that does not exist or
 * leaves the checkout is dropped.
 */
export async function existingEvidence(
  dir: string,
  evidence: readonly Evidence[],
): Promise<Evidence[]> {
  const root = resolve(dir)
  const checked = await Promise.all(
    evidence.map(async (entry) => {
      const path = resolve(root, entry.path.replace(/^\.?\//, ''))
      if (path !== root && !path.startsWith(`${root}${sep}`)) return false
      return Bun.file(path).exists()
    }),
  )
  return evidence.filter((_, index) => checked[index])
}
