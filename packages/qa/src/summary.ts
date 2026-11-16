import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import type { Issue } from '@holtkeeper/issues'
import { z } from 'zod'

import type { QaChange, QaChangeDetail } from './model.ts'

/** Task kind of QA summaries, for model routing and the Guide (section `testing`). */
export const qaSummaryTaskKind = 'qa-notes'

const testKinds = [
  'manual',
  'e2e',
  'integration',
  'unit',
  'api',
  'regression',
  'exploratory',
  'visual',
  'performance',
  'accessibility',
] as const

/** What the agent writes about one task for the people who test it. */
export const qaSummarySectionsSchema = z.object({
  overview: z
    .string()
    .describe(
      'Two to four sentences: what the task changes for users and the product, in product language',
    ),
  changes: z
    .array(z.string())
    .describe(
      'Notable changes in behavior, one sentence each, without code identifiers, variables or file names',
    ),
  verdict: z
    .enum(['must', 'should', 'optional'])
    .describe(
      '`must`: user-facing behavior changed; `should`: indirect impact worth a check; `optional`: no visible effect expected',
    ),
  verdictReason: z.string().describe('One sentence on why'),
  testCases: z
    .array(
      z.object({
        title: z.string(),
        priority: z.enum(['high', 'medium', 'low']),
        steps: z.array(z.string()).describe('Short imperative steps'),
        expected: z.string().describe('What should happen'),
      }),
    )
    .describe('Manual test cases; empty when nothing needs a manual check'),
  testing: z
    .array(
      z.object({
        kind: z.enum(testKinds),
        ideas: z.array(z.string()).describe('One sentence each'),
      }),
    )
    .describe('Ideas per kind of testing; only kinds that apply'),
  autotests: z
    .array(
      z.object({
        level: z.enum(['e2e', 'integration', 'unit', 'api']),
        idea: z.string().describe('What the test checks, one or two sentences'),
        testIds: z
          .array(z.string())
          .describe('Test attribute values it can use, only from the ones given, never invented'),
      }),
    )
    .describe('Automated tests worth adding or updating'),
  risks: z
    .array(z.string())
    .describe('Where it may break: edge cases, regressions in shared code, data, configuration'),
  questions: z
    .array(z.string())
    .describe('What is unclear from the changes and worth asking the developers'),
})

/** The sections of a QA summary. */
export type QaSummarySections = z.infer<typeof qaSummarySectionsSchema>

/** One change as the agent sees it, with what its diff touches and an excerpt of the diff. */
export interface QaSummaryChange {
  change: QaChange
  detail?: QaChangeDetail
  /** `diffExcerpt` of the change's diff. */
  excerpt?: string
}

/** A change without its head: `<forge>:<path>!12` or `<forge>:<path>@<short sha>`. */
export const changeIdentity = (change: QaChange) =>
  `${change.repo.forge}:${change.repo.path}${change.id.startsWith('!') ? change.id : `@${change.id}`}`

/** A change in a summary's inputs: its identity and head, `<identity>#<head sha>`. */
const changeInput = (change: QaChange) => `${changeIdentity(change)}#${change.head}`

const identity = (input: string) => input.slice(0, input.lastIndexOf('#'))

/** The inputs of a summary of `changes`, sorted, so equal sets compare equal. */
export const summaryInputs = (changes: readonly QaChange[]) =>
  [...new Set(changes.map(changeInput))].toSorted()

/** How the changes of a task differ from the ones a summary was written from. */
export interface QaStaleness {
  /** Changes the summary has not seen. */
  added: string[]
  /** Changes the summary saw that are gone (reverted, rewritten, out of the period). */
  removed: string[]
  /** Changes that moved on since (open merge requests with new commits). */
  updated: string[]
}

/**
 * What changed since a summary written from `inputs`: `undefined` when the current changes are
 * exactly the ones it saw. Entries are `changeIdentity` values.
 */
export function staleness(
  inputs: readonly string[],
  changes: readonly QaChange[],
): QaStaleness | undefined {
  const before = new Map(inputs.map((input) => [identity(input), input]))
  const now = new Map(summaryInputs(changes).map((input) => [identity(input), input]))
  const added = [...now.keys()].filter((id) => !before.has(id))
  const removed = [...before.keys()].filter((id) => !now.has(id))
  const updated = [...now].filter(([id, input]) => before.has(id) && before.get(id) !== input)
  if (!added.length && !removed.length && !updated.length) return undefined
  return { added, removed, updated: updated.map(([id]) => id) }
}

const kindLabels: Record<QaChange['kind'], string> = {
  'merge-request': 'merged merge request',
  'open-merge-request': 'open merge request (not merged yet)',
  commit: 'commit pushed without a merge request (no review)',
  merge: 'merge made outside the forge (no merge request)',
}

function describeChange({ change, detail, excerpt }: QaSummaryChange, budget: number): string {
  const lines = [
    `### ${change.repo.path} ${change.id} — ${kindLabels[change.kind]} into ${change.branch}`,
    `Title: ${change.mergeRequest?.title ?? change.title}`,
  ]
  const description = change.mergeRequest?.description.trim()
  if (description) lines.push(`Description:\n${description.slice(0, 1500)}`)
  if (detail?.files.length)
    lines.push(
      `Files (${detail.files.length}${detail.partial ? '+' : ''}): ${detail.files
        .slice(0, 60)
        .map((file) => `${file.path} (+${file.additions}/-${file.deletions})`)
        .join(', ')}`,
    )
  if (detail?.testIds.length)
    lines.push(
      `Test attributes:\n${detail.testIds
        .map(
          (file) =>
            `- ${file.file}: ${[
              ...file.added.map((ref) => `added ${ref.attribute}=${JSON.stringify(ref.value)}`),
              ...file.removed.map((ref) => `removed ${ref.attribute}=${JSON.stringify(ref.value)}`),
            ].join('; ')}`,
        )
        .join('\n')}`,
    )
  if (excerpt) lines.push(`Diff:\n${excerpt.slice(0, budget)}`)
  return lines.join('\n')
}

/** Inputs of `summarizeTask`. */
export interface QaSummaryInput {
  key: string
  title: string
  issue?: Issue
  /** Newest first. */
  changes: readonly QaSummaryChange[]
  /** Characters of diff excerpts across all changes; default 60 000. */
  diffBudget?: number
  /** Language of every text of the summary, e.g. `Russian`; default English. */
  language?: string
  signal?: AbortSignal
}

/**
 * A QA summary of one task written by the agent in one call (task kind `qa-notes`, tier `main`,
 * no repository access): what changed, whether and how to test it, test cases, ideas per kind
 * of testing and for automated tests, risks and open questions. The agent reads only what it is
 * given (merge request texts, file lists, test attribute changes and diff excerpts within
 * `diffBudget`) and writes in `language` (English by default); the Guide's `testing` section
 * reaches it as context of the task kind. Rejects
 * when the agent fails or answers without the structured result.
 */
export async function summarizeTask(
  agent: Agent,
  input: QaSummaryInput,
): Promise<{ sections: QaSummarySections; model?: string; costUsd?: number }> {
  const diffBudget = input.diffBudget ?? 60_000
  const withExcerpt = input.changes.filter((item) => item.excerpt).length || 1
  const perChange = Math.max(2_000, Math.floor(diffBudget / withExcerpt))
  const changes = input.changes.map((item) => describeChange(item, perChange))
  const testIds = input.changes.flatMap(
    (item) => item.detail?.testIds.flatMap((file) => file.added.map((ref) => ref.value)) ?? [],
  )
  const scratch = await mkdtemp(join(tmpdir(), 'holtkeeper-qa-'))
  try {
    const result = await agent.run({
      dir: scratch,
      system: [
        'You help QA engineers test a task: you explain what its changes do and how to test them.',
        'Write for testers, not developers: describe behavior in product language, never name variables, functions, classes or files in the overview, changes, test cases or risks.',
        'Be concise and concrete; base everything on the changes given and say so in questions when something is unclear instead of guessing.',
        'Changes pushed without a merge request were not reviewed: weigh them as riskier.',
        'Test attribute values in autotests must come from the ones listed; leave the list empty when none fits.',
        `Write every text in ${input.language ?? 'English'}. Keep test attribute values, product names and established technical terms (API, e2e, regression, ...) as they are.`,
        'Follow the team rules in the context for testing conventions; they win over these defaults.',
      ].join('\n'),
      prompt: [
        `Task ${input.key}: ${input.title}`,
        input.issue
          ? `Tracker: ${[input.issue.type, input.issue.status].filter(Boolean).join(', ')}`
          : '',
        `Changes, newest first:\n\n${changes.join('\n\n')}`,
        testIds.length
          ? `Test attribute values added by the task: ${[...new Set(testIds)].join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      capabilities: [],
      output: qaSummarySectionsSchema,
      maxTurns: 3,
      taskKind: qaSummaryTaskKind,
      tier: 'main',
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const sections = result.output
    if (!sections) throw new Error('the agent returned no structured answer')
    const known = new Set(testIds)
    return {
      sections: {
        ...sections,
        autotests: sections.autotests.map((test) => ({
          ...test,
          testIds: test.testIds.filter((id) => known.has(id)),
        })),
      },
      ...(result.model ? { model: result.model } : {}),
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
