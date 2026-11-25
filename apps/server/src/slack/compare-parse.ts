import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import type { RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import type { EnvironmentCandidate } from '../env-compare.ts'
import type { CompareRequest } from './compare-state.ts'

/** Task kind of the parse call; `release-*` so the release rules apply. */
const COMPARE_PARSE_TASK = 'release-compare-parse'

/** Limits of one parse: a single `fast` one-shot. */
const PARSE_LIMITS = { tier: 'fast', maxTurns: 1, maxCostUsd: 0.03 } as const

/** Candidates listed to the parser at most; larger fleets are cut. */
const MAX_CANDIDATES = 400

/** Slack user and channel mentions (`<@U123>`, `<!here>`), removed before parsing. */
export const stripMentions = (text: string) =>
  text
    .replace(/<[@!#][^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

const lowerKey = (repo: RepoRef) => `${repo.forge}:${repo.path}`.toLowerCase()

const lastSegment = (repo: RepoRef) => repo.path.slice(repo.path.lastIndexOf('/') + 1)

const onlyOne = (matches: readonly EnvironmentCandidate[]) =>
  matches.length === 1 ? matches[0]?.repo : undefined

/**
 * The known repository a name means: `forge:path` or a path in any case, else the last path
 * segment or a normalized form (`Widget Service` → `widget-service`) when exactly one matches.
 */
export function resolveRepoName(
  value: string,
  candidates: readonly EnvironmentCandidate[],
): RepoRef | undefined {
  const wanted = value.trim().toLowerCase()
  if (!wanted) return undefined
  const exact = candidates.find(
    (candidate) =>
      lowerKey(candidate.repo) === wanted || candidate.repo.path.toLowerCase() === wanted,
  )
  if (exact) return exact.repo
  const tail = wanted.slice(wanted.lastIndexOf('/') + 1)
  return (
    onlyOne(candidates.filter((candidate) => lastSegment(candidate.repo).toLowerCase() === tail)) ??
    onlyOne(
      candidates.filter((candidate) => normalize(lastSegment(candidate.repo)) === normalize(tail)),
    )
  )
}

const ALIASES: readonly (readonly string[])[] = [
  ['prod', 'production', 'prd', 'live'],
  ['cert', 'certification', 'certify'],
  ['stage', 'staging', 'stg'],
  ['dev', 'development'],
  ['test', 'testing', 'qa'],
  ['preprod', 'preproduction', 'pre-prod'],
]

/** The configured environment a name means: exact or normalized match, a common alias, a unique prefix. */
export function resolveEnvironment(
  value: string,
  environments: readonly string[],
): string | undefined {
  const wanted = normalize(value)
  if (!wanted) return undefined
  const exact = environments.find((name) => normalize(name) === wanted)
  if (exact) return exact
  const group = ALIASES.find((names) => names.some((name) => normalize(name) === wanted))
  const aliased = group
    ? environments.filter((name) => group.some((alias) => normalize(alias) === normalize(name)))
    : []
  if (aliased.length === 1) return aliased[0]
  const prefixed = environments.filter(
    (name) => normalize(name).startsWith(wanted) || wanted.startsWith(normalize(name)),
  )
  return prefixed.length === 1 ? prefixed[0] : undefined
}

const parsedSchema = z.object({
  repos: z
    .array(z.string())
    .describe(
      'Repositories as forge:path from the known list; names you cannot match go to unknown',
    ),
  unknown: z.array(z.string()).describe('Repository names as written that match nothing known'),
  from: z.string().optional().describe('The first environment, the one compared from'),
  to: z.string().optional().describe('The second environment, the one compared against'),
  focus: z
    .array(z.enum(['changes', 'tasks', 'dependencies', 'breaking']))
    .describe('Only what the person narrowed it to; empty for everything'),
  language: z.string().optional().describe('The language the person wrote in, e.g. English'),
  intent: z
    .enum(['request', 'confirm', 'cancel'])
    .describe(
      'With a previous request: confirm when the message only agrees to run it, cancel when it calls it off, else request',
    ),
  question: z
    .string()
    .optional()
    .describe('Set only when the message is not a comparison request: one short question back'),
})

const SYSTEM = `You turn a Slack message into a request to compare which versions of repositories run on two deploy environments.
Pick repositories only from the known list and answer them as forge:path; people write names loosely (other case, spaces, partial names, translations). Names you cannot match go to "unknown".
Environments: use the configured names of the chosen repositories when the person means them (prod may be production, cert may be certification). Keep the person's order: the first environment named is "from".
When a previous request is given, the message answers it in any language: "intent" is confirm when it only agrees to run it, cancel when it calls it off, else request with the corrected fields (change only what the message changes and keep the rest).
Set "question" only when the message asks for something else entirely.`

/** The parser's answer: a request, or a question to ask back. */
export type ParsedCompare =
  | { kind: 'request'; request: CompareRequest }
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  | { kind: 'question'; text: string }

/**
 * Reads a free-text Slack message into a comparison request with one `fast` call
 * (`COMPARE_PARSE_TASK`): repositories resolved against `candidates` (anything the model returns
 * that matches no candidate goes to `unresolved`), environments as written. With `previous`, the
 * message answers that request: a confirmation, a cancel, or a correction. Throws what the agent throws (budget refusals included).
 */
export async function parseCompareRequest(
  agent: Agent,
  input: {
    text: string
    candidates: readonly EnvironmentCandidate[]
    previous?: CompareRequest
  },
): Promise<ParsedCompare> {
  const known = input.candidates
    .slice(0, MAX_CANDIDATES)
    .map(
      (candidate) =>
        `- ${candidate.repo.forge}:${candidate.repo.path} (environments: ${candidate.environments.join(', ')})`,
    )
  const prompt = [
    'Known repositories:',
    ...(known.length > 0 ? known : ['(none)']),
    '',
    ...(input.previous
      ? ['Previous request:', JSON.stringify(input.previous), '', 'Correction:']
      : ['Message:']),
    stripMentions(input.text),
  ].join('\n')
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-compare-'))
  try {
    const result = await agent.run({
      dir,
      system: SYSTEM,
      prompt,
      output: parsedSchema,
      taskKind: COMPARE_PARSE_TASK,
      capabilities: [],
      ...PARSE_LIMITS,
    })
    const parsed = parsedSchema.safeParse(result.output)
    if (!parsed.success) throw new Error('the parser answered no request')
    const answer = parsed.data
    if (input.previous && answer.intent !== 'request') return { kind: answer.intent }
    if (answer.question && answer.repos.length === 0 && !input.previous)
      return { kind: 'question', text: answer.question }
    const repos: string[] = []
    const unresolved = [...answer.unknown]
    for (const name of answer.repos) {
      const repo = resolveRepoName(name, input.candidates)
      if (!repo) unresolved.push(name)
      else if (!repos.includes(`${repo.forge}:${repo.path}`))
        repos.push(`${repo.forge}:${repo.path}`)
    }
    return {
      kind: 'request',
      request: {
        repos,
        unresolved: [...new Set(unresolved)],
        ...(answer.from && { from: answer.from }),
        ...(answer.to && { to: answer.to }),
        focus: answer.focus,
        ...((answer.language ?? input.previous?.language) && {
          language: answer.language ?? input.previous?.language,
        }),
      },
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
