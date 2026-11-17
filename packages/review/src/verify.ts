import { resolve, sep } from 'node:path'

import type { Agent, Toolset } from '@holtkeeper/agent'
import { z } from 'zod'

import {
  KEEP_ENGLISH,
  REVIEW_BUDGET_SHARES,
  REVIEW_READ_LINES,
  REVIEW_TRIM,
  runTracked,
} from './agent.ts'
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

/**
 * Turn limit of a verification task: a base plus a few turns per finding. The prompt already
 * carries the code around each finding and its evidence, so most findings need few reads.
 */
export const verifyTurns = (findings: number) => Math.min(30, 6 + findings * 2)

/** Lines shown before and after a finding's line, and around a cited evidence line. */
const FINDING_CONTEXT = 12
const EVIDENCE_CONTEXT = 4
/** Cited evidence entries with a line that get an excerpt. */
const EVIDENCE_EXCERPTS = 3

/**
 * Numbered lines `from`–`to` of `path` inside `dir`, or `undefined` for a file that is missing,
 * outside the checkout or unreadable.
 */
async function excerpt(
  dir: string,
  path: string,
  from: number,
  to: number,
): Promise<string | undefined> {
  const root = resolve(dir)
  const file = resolve(root, path.replace(/^\.?\//, ''))
  if (!file.startsWith(`${root}${sep}`)) return undefined
  try {
    const lines = (await Bun.file(file).text()).split('\n')
    const start = Math.max(1, from)
    const end = Math.min(lines.length, to)
    if (start > end) return undefined
    return lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(5)}  ${line}`)
      .join('\n')
  } catch {
    return undefined
  }
}

/** The code around a finding and around up to `EVIDENCE_EXCERPTS` of its cited lines. */
async function excerptsOf(dir: string, candidate: Candidate): Promise<string> {
  const first = candidate.startLine ?? candidate.line
  const own = await excerpt(
    dir,
    candidate.path,
    first - FINDING_CONTEXT,
    candidate.line + FINDING_CONTEXT,
  )
  const cited = await Promise.all(
    (candidate.evidence ?? [])
      .filter((entry) => entry.line !== undefined)
      .slice(0, EVIDENCE_EXCERPTS)
      .map(async (entry) => {
        const line = entry.line ?? 1
        const text = await excerpt(
          dir,
          entry.path,
          line - EVIDENCE_CONTEXT,
          line + EVIDENCE_CONTEXT,
        )
        return text ? `${entry.path}:${line}\n\`\`\`\n${text}\n\`\`\`` : ''
      }),
  )
  return [own ? `Code at the finding (${candidate.path}):\n\`\`\`\n${own}\n\`\`\`` : '', ...cited]
    .filter(Boolean)
    .join('\n\n')
}

const SYSTEM = [
  'You are the second reviewer of a merge request. Another reviewer wrote the findings below; most are right, some rest on a wrong reading of code outside the diff. The checkout is at the merge request head.',
  'For each finding, try to disprove it: read the code it is about and the code its premise depends on with the tools — callers, guards before the line, other methods that read or write the same value, the tests of the changed code (they may be added by this very merge request), the commit history when the finding is about what changed. Each finding comes with the numbered code around it and its cited lines; start from them and read further only what the premise depends on. The cited evidence is a starting point, not proof.',
  'Answer per finding:',
  '- `refuted`: the code shows the claim is wrong (the guard exists, the value is reset elsewhere, the tests exist, the fix would break a caller that relies on the current behavior, the case cannot happen). The reason names where (path:line).',
  '- `confirmed`: you checked the premise and it holds. A remark that is a matter of taste is confirmed unless its factual premise is wrong.',
  '- `uncertain`: you could not tell either way.',
  'Answer for every finding, keeping its id. The reason is one or two sentences.',
  KEEP_ENGLISH,
].join('\n')

const describe = (candidate: Candidate, id: number, code: string) =>
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
    code,
  ]
    .filter(Boolean)
    .join('\n\n')

const isBudgetStop = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'BudgetExceededError' || isBudgetStop(error.cause))

/**
 * Lets a skeptical second pass try to disprove the agent's findings with the tools and drops the
 * ones it refutes; confirmed, uncertain and unanswered findings stay. Findings from checks (any
 * `source` but `agent`) are never sent and always stay. Major and critical findings are checked on
 * the `deep` tier, the rest on `main`, each group in one task of kind
 * `review-verify`, both at once. A group whose task fails keeps all its findings and counts in
 * `failed`; an abort is rethrown, a spend limit is not (the review goes on unverified).
 */
export async function verifyFindings(options: {
  agent: Agent
  dir: string
  candidates: readonly Candidate[]
  usage: ReviewUsage
  mergeRequest: { title: string; description: string }
  /**
   * Soft spend limit of the whole review in USD; verification may spend its
   * `REVIEW_BUDGET_SHARES.verify` share, 60% of it on major and critical findings when both
   * groups run, all of it when one does.
   */
  costLimitUsd?: number
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
  const both = serious.length > 0 && rest.length > 0
  const groups = [
    { findings: serious, deep: true, share: both ? 0.6 : 1 },
    { findings: rest, deep: false, share: both ? 0.4 : 1 },
  ].filter((group) => group.findings.length)
  const code = new Map(
    await Promise.all(
      agentFindings.map(
        async ({ candidate, id }) => [id, await excerptsOf(options.dir, candidate)] as const,
      ),
    ),
  )

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
              ...group.findings.map(({ candidate, id }) =>
                describe(candidate, id, code.get(id) ?? ''),
              ),
            ]
              .filter(Boolean)
              .join('\n\n'),
            capabilities: ['read', 'search'],
            output: verdictSchema,
            taskKind: 'review-verify',
            tier: group.deep ? 'deep' : 'main',
            ...(options.toolsets ? { toolsets: options.toolsets } : {}),
            maxTurns: verifyTurns(group.findings.length),
            readLines: REVIEW_READ_LINES,
            trimToolResults: REVIEW_TRIM,
            ...(options.costLimitUsd && {
              answerAtCostUsd: options.costLimitUsd * REVIEW_BUDGET_SHARES.verify * group.share,
            }),
            ...(options.signal ? { signal: options.signal } : {}),
          },
          options.usage,
          {
            label: `verification of ${group.findings.length} finding(s) on ${group.deep ? 'deep' : 'main'}`,
            log: options.log,
          },
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
