import type { Agent } from '@holtkeeper/agent'
import type { LessonDraft } from '@holtkeeper/knowledge'
import type { KnowledgeLink } from '@holtkeeper/store'

import type { BootstrapEvidence } from './evidence-code.ts'
import type { MergeRequestRef } from './evidence-mr.ts'
import {
  BOOTSTRAP_CONTEXT,
  BOOTSTRAP_SYSTEM,
  type BootstrapOutput,
  type BootstrapPromptInput,
  bootstrapOutput,
  bootstrapPrompt,
} from './prompt.ts'

/** Model tiers a run may use. */
export type BootstrapTier = 'main' | 'deep'

/** Spend cap of one starter knowledge call per tier, in USD. */
export const CALL_CAPS: Readonly<Record<BootstrapTier, number>> = { main: 0.4, deep: 1 }

/**
 * Reference prices per million tokens the estimate uses, per tier: a Sonnet-class model on
 * `main`, an Opus-class one on `deep`. The real cap is `CALL_CAPS`.
 */
export const REFERENCE_PRICES: Readonly<Record<BootstrapTier, { input: number; output: number }>> =
  {
    main: { input: 3, output: 15 },
    deep: { input: 5, output: 25 },
  }

/** Output tokens the estimate counts per requested lesson. */
export const OUTPUT_TOKENS_PER_LESSON = 500

/** Expected cost of one call over a prompt of `promptChars`, at four characters per token. */
export function estimateBootstrapCost(
  promptChars: number,
  tier: BootstrapTier,
  maxEntries = 10,
): { inputTokens: number; outputTokens: number; usd: number } {
  const inputTokens = Math.ceil((promptChars + BOOTSTRAP_SYSTEM.length) / 4)
  const outputTokens = maxEntries * OUTPUT_TOKENS_PER_LESSON
  const price = REFERENCE_PRICES[tier]
  const usd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000
  return { inputTokens, outputTokens, usd: Math.round(usd * 10_000) / 10_000 }
}

/** Where evidence ids link to. */
export interface EvidenceLinks {
  /** Forge kind, `gitlab` or `github`, for file links. */
  forgeKind?: string
  /** Web URL of the repository. */
  webUrl?: string
  /** Commit the checkout was read at. */
  sha?: string
  mergeRequests: readonly MergeRequestRef[]
}

/** The link a lesson citing `item` gets, if any. */
export function evidenceLink(
  item: Pick<BootstrapEvidence, 'id' | 'label' | 'path'>,
  links: EvidenceLinks,
): KnowledgeLink | undefined {
  const mr = /^mr:(\d+)$/.exec(item.id)
  if (mr) {
    const found = links.mergeRequests.find((candidate) => candidate.id === Number(mr[1]))
    return found?.webUrl ? { label: `!${found.id} ${found.title}`, url: found.webUrl } : undefined
  }
  const web = links.webUrl?.replace(/\/+$/, '')
  if (!web) return undefined
  const gitlab = links.forgeKind === 'gitlab'
  const github = links.forgeKind === 'github'
  if (!gitlab && !github) return undefined
  if (item.id === 'mr-titles')
    return {
      label: item.label,
      url: gitlab ? `${web}/-/merge_requests?state=merged` : `${web}/pulls?q=is%3Apr+is%3Amerged`,
    }
  if (!links.sha) return undefined
  if (item.path)
    return {
      label: item.label,
      url: `${web}${gitlab ? '/-' : ''}/blob/${links.sha}/${item.path}`,
    }
  return { label: item.label, url: `${web}${gitlab ? '/-' : ''}/tree/${links.sha}` }
}

/** A lesson the post-check left out, with why. */
export interface DroppedLesson {
  title: string
  reason: string
}

/** What `acceptLessons` checks the answer against. */
export interface AcceptContext {
  evidence: readonly BootstrapEvidence[]
  /** Ids of the existing entries the prompt listed. */
  existingIds: ReadonlySet<string>
  /** Subjects of the repository's direct dependencies. */
  dependencies: ReadonlySet<string>
  maxEntries: number
  links: EvidenceLinks
}

function librarySubject(value: string | undefined, dependencies: ReadonlySet<string>) {
  if (!value) return undefined
  const candidates = [value, `Go:${value}`, `npm:${value}`, value.replace(/^go:/i, 'Go:')]
  return candidates.find((candidate) => dependencies.has(candidate))
}

/**
 * The deterministic check of the model's answer: evidence ids the run did not provide are
 * dropped, and so is a lesson left with none; a `library` that is not a direct dependency turns
 * the lesson into a repository lesson; `related` keeps only ids the prompt listed (`kb:` prefix
 * optional); a migration without a library becomes a how-to; the list is cut to `maxEntries`.
 * Cited evidence becomes the lesson's links (`evidenceLink`).
 */
export function acceptLessons(
  output: BootstrapOutput,
  context: AcceptContext,
): { lessons: LessonDraft[]; dropped: DroppedLesson[] } {
  const byId = new Map(context.evidence.map((item) => [item.id, item]))
  const lessons: LessonDraft[] = []
  const dropped: DroppedLesson[] = []
  for (const answer of output.lessons) {
    const cited = [...new Set(answer.evidence.map((id) => id.trim()))].filter((id) => byId.has(id))
    if (!cited.length) {
      dropped.push({ title: answer.title, reason: 'no known evidence' })
      continue
    }
    if (lessons.length >= context.maxEntries) {
      dropped.push({ title: answer.title, reason: `over the limit of ${context.maxEntries}` })
      continue
    }
    const library =
      answer.level === 'library' || answer.kind === 'migration'
        ? librarySubject(answer.library, context.dependencies)
        : undefined
    const related = (answer.related ?? [])
      .map((id) => id.trim().replace(/^kb:/, ''))
      .filter((id) => context.existingIds.has(id))
    const links = new Map<string, KnowledgeLink>()
    for (const id of cited) {
      const item = byId.get(id)
      const link = item && evidenceLink(item, context.links)
      if (link && !links.has(link.url)) links.set(link.url, link)
    }
    lessons.push({
      title: answer.title,
      body: answer.body,
      kind: answer.kind === 'migration' && !library ? 'howto' : answer.kind,
      ...(answer.topics?.length && { topics: answer.topics }),
      evidence: [...links.values()],
      level: library ? 'library' : answer.level === 'library' ? 'repo' : answer.level,
      ...(library && { library }),
      repoSpecific: answer.repoSpecific,
      ...(related.length && { related: [...new Set(related)] }),
      ...(answer.general && { general: answer.general }),
    })
  }
  return { lessons, dropped }
}

/** What one generation needs. */
export interface GenerateLessonsInput {
  agent: Agent
  /** Directory the agent runs in; it gets no tools. */
  dir: string
  prompt: BootstrapPromptInput
  tier: BootstrapTier
  links: EvidenceLinks
  signal?: AbortSignal
  log?: (line: string) => void
}

/** The call a run made. */
export interface BootstrapCall {
  tier: BootstrapTier
  model: string
  costUsd: number
  estimateUsd: number
}

/**
 * One agent call that turns the evidence into lessons, checked by `acceptLessons`. The call gets
 * no tools, at most two turns, the cap of its tier (`CALL_CAPS`) and the estimate
 * (`estimateBootstrapCost`) for the budget check, logged before it starts. A
 * `BudgetExceededError` (the weekly budget refused the run or the cap was reached) propagates.
 */
export async function generateLessons(
  input: GenerateLessonsInput,
): Promise<{ lessons: LessonDraft[]; dropped: DroppedLesson[]; call: BootstrapCall }> {
  const prompt = bootstrapPrompt(input.prompt)
  const estimate = estimateBootstrapCost(prompt.length, input.tier, input.prompt.maxEntries)
  input.log?.(
    `budget: estimate $${estimate.usd.toFixed(2)}, cap $${CALL_CAPS[input.tier].toFixed(2)} (tier ${input.tier}, ~${Math.round(estimate.inputTokens / 1000)}k input tokens)`,
  )
  const answer = await input.agent.run({
    dir: input.dir,
    system: BOOTSTRAP_SYSTEM,
    context: BOOTSTRAP_CONTEXT,
    prompt,
    capabilities: [],
    output: bootstrapOutput,
    maxTurns: 2,
    tier: input.tier,
    maxCostUsd: CALL_CAPS[input.tier],
    estimateUsd: estimate.usd,
    taskKind: 'knowledge-bootstrap',
    ...(input.signal && { signal: input.signal }),
  })
  const accepted = acceptLessons(answer.output ?? { lessons: [] }, {
    evidence: input.prompt.evidence,
    existingIds: new Set(input.prompt.existing.map((entry) => entry.id)),
    dependencies: new Set(input.prompt.dependencies),
    maxEntries: input.prompt.maxEntries,
    links: input.links,
  })
  return {
    ...accepted,
    call: {
      tier: input.tier,
      model: answer.model ?? `tier:${input.tier}`,
      costUsd: answer.costUsd ?? 0,
      estimateUsd: estimate.usd,
    },
  }
}
