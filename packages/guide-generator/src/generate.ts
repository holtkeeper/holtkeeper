import { createHash } from 'node:crypto'

import type { Agent, ModelTier } from '@holtkeeper/agent'
import type { GuideGenerated, GuideGeneratedInput, GuideSection } from '@holtkeeper/store'

import type { Evidence } from './evidence.ts'
import {
  GENERATOR_CONTEXT,
  GENERATOR_SYSTEM,
  GENERATOR_VERSION,
  type GeneratedSection,
  type LlmSection,
  type SectionPrompt,
  generatorOutput,
  generatorPrompt,
  isLlmSection,
  renderBullets,
} from './prompt.ts'

/** Model name stored on the deterministic `commits` section. */
export const DETERMINISTIC_MODEL = 'deterministic'

/** Spend cap of one generator call per tier, in USD. */
export const CALL_CAPS: Readonly<Record<'fast' | 'main', number>> = { fast: 0.1, main: 0.5 }

/**
 * The hash that gates a section: its evidence, its steering and `GENERATOR_VERSION`. Team rules
 * and the one-off extra prompt are left out on purpose, so editing rules or regenerating by hand
 * does not make the next scheduled run call the LLM again.
 */
export function sectionHash(
  section: GeneratedSection,
  evidence: readonly Evidence[],
  steering = '',
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: GENERATOR_VERSION,
        section,
        evidence: evidence.map((item) => [item.id, item.text]),
        steering: steering.trim(),
      }),
    )
    .digest('hex')
}

/** The generated text a new run is compared with: the pending proposal, else the generated layer. */
export const latestGenerated = (row: GuideSection | undefined): GuideGenerated | undefined =>
  row?.proposal ?? row?.generated

/** Text waiting for a person to accept it, when there is any. */
export const pendingGenerated = (row: GuideSection | undefined): GuideGenerated | undefined =>
  row?.proposal ?? (row?.generated?.status === 'proposed' ? row.generated : undefined)

/**
 * Where a new `layer` goes on `row`. Over accepted text it becomes the `proposal` (agents keep
 * the accepted text), unless its body is empty or equals the accepted one: then the accepted layer only takes
 * the new hash and commit (`kept`). Without accepted text it replaces `generated`.
 */
export function placeGenerated(
  row: GuideSection | undefined,
  layer: GuideGeneratedInput,
): {
  generated: GuideGeneratedInput
  proposal?: GuideGeneratedInput
  outcome: 'proposed' | 'kept'
} {
  const accepted = row?.generated?.status === 'accepted' ? row.generated : undefined
  if (!accepted) return { generated: layer, outcome: 'proposed' }
  if (!layer.body.trim() || accepted.body.trim() === layer.body.trim())
    return {
      generated: {
        ...accepted,
        inputHash: layer.inputHash,
        ...(layer.sha !== undefined && { sha: layer.sha }),
      },
      outcome: 'kept',
    }
  return { generated: accepted, proposal: layer, outcome: 'proposed' }
}

/** What the generator knows about one section before deciding. */
export interface SectionInput {
  section: GeneratedSection
  evidence: Evidence[]
  /** Steering of the section's scopes, strongest first. */
  steering: string
  /** Team rules of the section's scopes, strongest first. */
  rules: string
  /** The repository's stored row of the section. */
  stored?: GuideSection
  /** For `commits`: the rendered text; the evidence is that text. */
  text?: string
  /** Hashes of versions a person rejected; never proposed again, even when forced. */
  rejected?: ReadonlySet<string>
}

/** How a run treated one section. */
export type SectionOutcome = 'proposed' | 'kept' | 'unchanged' | 'skipped'

export interface SectionResult {
  section: GeneratedSection
  outcome: SectionOutcome
  inputHash?: string
  /** Why it was skipped. */
  reason?: string
  evidence: { id: string; label: string }[]
  /** The new layer, for `proposed` and `kept`; store it with `placeGenerated` (the store numbers it). */
  layer?: GuideGeneratedInput
}

/** The one LLM call of a run, when there was one. */
export interface GeneratorCall {
  tier: ModelTier
  model: string
  costUsd: number
  sections: LlmSection[]
}

export interface GenerateInput {
  sections: readonly SectionInput[]
  agent?: Agent
  /** Directory the agent runs in; it gets no tools. */
  dir: string
  /** One-off extra prompt; stored with every layer the run writes. */
  prompt?: string
  /** Ignore unchanged hashes. */
  force?: boolean
  /** Commit the evidence was read at. */
  sha?: string
  /** The job of the run; stored with every layer it writes. */
  jobId?: string
  now: () => Date
  signal?: AbortSignal
  log?: (line: string) => void
}

export interface GenerateResult {
  sections: SectionResult[]
  call?: GeneratorCall
}

/**
 * Decides and writes the generated layer of each section; stores nothing itself. Sections without
 * evidence are skipped. A section whose hash equals that of its latest generated text is
 * `unchanged` and costs nothing (unless `force`); one whose hash a person rejected is skipped,
 * forced or not. `commits` is written from its text without an
 * LLM. The remaining LLM sections go into one agent call: on tier `main` when `general` is among
 * them, else `fast`, with no tools and a spend cap (`CALL_CAPS`). Without an agent they are
 * skipped. A `BudgetExceededError` from the agent propagates, so the job is blocked; nothing of
 * the run is kept then.
 */
export async function generateGuide(input: GenerateInput): Promise<GenerateResult> {
  const results: SectionResult[] = []
  const due: { input: SectionInput; hash: string }[] = []
  const at = input.now().toISOString()
  const base = (hash: string) => ({
    inputHash: hash,
    status: 'proposed' as const,
    generatedAt: at,
    ...(input.sha !== undefined && { sha: input.sha }),
    ...(input.jobId !== undefined && { jobId: input.jobId }),
    ...(input.prompt?.trim() && { prompt: input.prompt.trim() }),
  })

  for (const section of input.sections) {
    const evidence = section.evidence.map(({ id, label }) => ({ id, label }))
    if (!section.evidence.length || (section.section === 'commits' && !section.text?.trim())) {
      results.push({
        section: section.section,
        outcome: 'skipped',
        reason: 'no evidence',
        evidence,
      })
      continue
    }
    const steering = section.section === 'commits' ? '' : section.steering
    const hash = sectionHash(section.section, section.evidence, steering)
    if (!input.force && latestGenerated(section.stored)?.inputHash === hash) {
      results.push({ section: section.section, outcome: 'unchanged', inputHash: hash, evidence })
      continue
    }
    if (section.rejected?.has(hash)) {
      results.push({
        section: section.section,
        outcome: 'skipped',
        inputHash: hash,
        reason: 'a person rejected text from these inputs',
        evidence,
      })
      continue
    }
    if (section.section === 'commits') {
      const layer: GuideGeneratedInput = {
        ...base(hash),
        body: section.text?.trim() ?? '',
        model: DETERMINISTIC_MODEL,
        costUsd: 0,
      }
      results.push({
        section: section.section,
        outcome: placeGenerated(section.stored, layer).outcome,
        inputHash: hash,
        evidence,
        layer,
      })
      continue
    }
    if (!input.agent) {
      results.push({
        section: section.section,
        outcome: 'skipped',
        inputHash: hash,
        reason: 'no AI agent is configured',
        evidence,
      })
      continue
    }
    due.push({ input: section, hash })
  }

  const llm = due.filter((entry) => isLlmSection(entry.input.section))
  if (!llm.length || !input.agent) return { sections: order(input.sections, results) }

  const names = llm.map((entry) => entry.input.section).filter(isLlmSection)
  const tier = names.includes('general') ? 'main' : 'fast'
  input.log?.(`generating ${names.join(', ')} on tier ${tier}`)
  const prompts: SectionPrompt[] = llm.flatMap((entry) =>
    isLlmSection(entry.input.section)
      ? [
          {
            section: entry.input.section,
            evidence: entry.input.evidence,
            steering: entry.input.steering,
            rules: entry.input.rules,
          },
        ]
      : [],
  )
  const answer = await input.agent.run({
    dir: input.dir,
    system: GENERATOR_SYSTEM,
    context: GENERATOR_CONTEXT,
    prompt: generatorPrompt(prompts, input.prompt),
    capabilities: [],
    output: generatorOutput,
    maxTurns: 2,
    maxCostUsd: CALL_CAPS[tier],
    tier,
    taskKind: 'guide',
    ...(input.signal && { signal: input.signal }),
  })
  const model = answer.model ?? `tier:${tier}`
  const costUsd = answer.costUsd ?? 0
  const share = Math.round((costUsd / llm.length) * 1e6) / 1e6
  for (const entry of llm) {
    const section = entry.input.section
    const lines = isLlmSection(section) ? (answer.output?.sections[section] ?? []) : []
    const layer: GuideGeneratedInput = {
      ...base(entry.hash),
      body: renderBullets(lines),
      model,
      costUsd: share,
    }
    results.push({
      section,
      outcome: placeGenerated(entry.input.stored, layer).outcome,
      inputHash: entry.hash,
      evidence: entry.input.evidence.map(({ id, label }) => ({ id, label })),
      layer,
    })
  }
  return {
    sections: order(input.sections, results),
    call: { tier, model, costUsd, sections: names },
  }
}

const order = (inputs: readonly SectionInput[], results: SectionResult[]) =>
  inputs.flatMap((input) => results.filter((result) => result.section === input.section))
