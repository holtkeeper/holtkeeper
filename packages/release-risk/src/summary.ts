import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import { formatRef } from '@holtkeeper/report'
import { z } from 'zod'

import { regularCommits, type RiskAssessment } from './assess.ts'
import type { ChangelogView, ChangelogViewCommit } from './inputs.ts'
import type { RiskSummary } from './schema.ts'

const groups = [
  { id: 'breaking', title: 'Breaking', test: (c: ChangelogViewCommit) => c.parsed.breaking },
  { id: 'features', title: 'New', test: (c: ChangelogViewCommit) => c.parsed.type === 'feat' },
  { id: 'fixes', title: 'Fixed', test: (c: ChangelogViewCommit) => c.parsed.type === 'fix' },
  {
    id: 'performance',
    title: 'Faster',
    test: (c: ChangelogViewCommit) => c.parsed.type === 'perf',
  },
  {
    id: 'reverts',
    title: 'Reverted',
    test: (c: ChangelogViewCommit) => c.parsed.revert !== undefined || c.parsed.type === 'revert',
  },
] as const

/** User-visible changes of a changelog by group (breaking first), deduplicated by title. */
export function userChanges(changelog: ChangelogView): { title: string; items: string[] }[] {
  const commits = regularCommits(changelog).filter((commit) => !commit.parsed.wip)
  const taken = new Set<string>()
  const result: { title: string; items: string[] }[] = []
  for (const group of groups) {
    const items: string[] = []
    for (const commit of commits) {
      if (taken.has(commit.sha) || !group.test(commit)) continue
      taken.add(commit.sha)
      const title = commit.parsed.description || commit.subject
      const text = commit.parsed.scope ? `${commit.parsed.scope}: ${title}` : title
      if (!items.includes(text)) items.push(text)
    }
    if (items.length > 0) result.push({ title: group.title, items })
  }
  return result
}

const bullets = (items: string[], limit: number) => {
  const shown = items.slice(0, limit).map((item) => `- ${item}`)
  if (items.length > limit) shown.push(`- ...and ${items.length - limit} more`)
  return shown.join('\n')
}

const headline = (assessment: RiskAssessment) =>
  `Risk: **${assessment.level}** (${assessment.score}/100, confidence ${Math.round(assessment.confidence * 100)}%).`

/**
 * A summary built from the changelog groups and the assessment, without an LLM: what changed,
 * what to test, and the factors that scored.
 */
export function deterministicSummary(
  assessment: RiskAssessment,
  changelog: ChangelogView | undefined,
): RiskSummary {
  const parts = [
    `**Release ${assessment.ref ? formatRef(assessment.ref) : 'unknown'}.** ${headline(assessment)}`,
    '### What changed for users',
  ]
  const changes = changelog ? userChanges(changelog) : []
  if (changes.length === 0)
    parts.push(changelog ? 'No user-facing changes recorded.' : 'No changelog available.')
  for (const group of changes) parts.push(`**${group.title}**\n\n${bullets(group.items, 8)}`)
  parts.push('### What to test')
  parts.push(
    assessment.testAreas.length > 0
      ? bullets(
          assessment.testAreas.map((area) => `**${area.area}**: ${area.reasons.join('; ')}`),
          10,
        )
      : 'Nothing specific; run the usual smoke tests.',
  )
  parts.push('### Risks')
  const risky = assessment.factors.filter((factor) => factor.points > 0)
  parts.push(
    risky.length > 0
      ? bullets(
          risky.map((factor) => `${factor.label}: ${factor.detail}`),
          8,
        )
      : 'No risk factor scored.',
  )
  return { source: 'changelog', markdown: parts.join('\n\n') }
}

/** What the agent must answer with. */
export const agentSummarySchema = z.object({
  overview: z.string().describe('One or two sentences about the release, in plain language'),
  changes: z.array(z.string()).describe('What changed for users, one short sentence each'),
  test: z.array(z.string()).describe('What QA should test, one short sentence each'),
  risks: z.array(z.string()).describe('Risks a manager should know about'),
})
export type AgentSummary = z.infer<typeof agentSummarySchema>

const section = (title: string, items: string[]) =>
  `### ${title}\n\n${items.length > 0 ? bullets(items, 12) : 'Nothing noteworthy.'}`

/** Markdown of an agent's structured summary. */
export function renderAgentSummary(answer: AgentSummary, assessment: RiskAssessment): string {
  return [
    `${answer.overview.trim()} ${headline(assessment)}`,
    section('What changed for users', answer.changes),
    section('What to test', answer.test),
    section('Risks', answer.risks),
  ].join('\n\n')
}

const system = [
  'You write release summaries for QA engineers and managers who do not read code.',
  'Use plain language, no commit hashes or internal jargon. Keep every item to one sentence.',
  'Base everything on the data given; you may read the checkout to understand a change, never modify it.',
].join(' ')

function promptFor(assessment: RiskAssessment, changelog: ChangelogView | undefined) {
  const facts = {
    release: assessment.ref,
    risk: { score: assessment.score, level: assessment.level },
    changes: changelog ? userChanges(changelog) : [],
    otherCommits: changelog
      ? regularCommits(changelog)
          .filter((commit) => !commit.parsed.wip)
          .slice(0, 80)
          .map((commit) => commit.subject)
      : [],
    areasToTest: assessment.testAreas,
    factors: assessment.factors
      .filter((factor) => factor.points > 0)
      .map((factor) => ({ factor: factor.label, points: factor.points, detail: factor.detail })),
  }
  return [
    'Summarize this release: what changed for users, what to test, and the risks.',
    'Release data as JSON:',
    JSON.stringify(facts, null, 2),
  ].join('\n\n')
}

export interface SummaryOptions {
  agent?: Agent
  /** Checkout the agent may read; an empty temporary directory is used without one. */
  dir?: string
  signal?: AbortSignal
  log?: (line: string) => void
}

/**
 * The release summary: written by the agent when one is given (read-only, structured output),
 * otherwise or when the agent fails built from the changelog by `deterministicSummary`.
 */
export async function summarizeRelease(
  assessment: RiskAssessment,
  changelog: ChangelogView | undefined,
  options: SummaryOptions = {},
): Promise<RiskSummary> {
  const { agent, signal, log } = options
  if (!agent) return deterministicSummary(assessment, changelog)
  const scratch = options.dir ? undefined : await mkdtemp(join(tmpdir(), 'holtkeeper-risk-'))
  try {
    const result = await agent.run({
      dir: options.dir ?? scratch!,
      system,
      prompt: promptFor(assessment, changelog),
      capabilities: ['read', 'search'],
      output: agentSummarySchema,
      maxTurns: 8,
      ...(signal ? { signal } : {}),
    })
    if (!result.output) throw new Error('agent returned no structured answer')
    return {
      source: 'agent',
      agent: agent.name,
      markdown: renderAgentSummary(result.output, assessment),
    }
  } catch (error) {
    signal?.throwIfAborted()
    log?.(
      `release summary by ${agent.name} failed, using the changelog: ${error instanceof Error ? error.message : String(error)}`,
    )
    return deterministicSummary(assessment, changelog)
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }
}
