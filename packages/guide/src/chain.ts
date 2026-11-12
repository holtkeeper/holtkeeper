import type { RepoTarget } from '@holtkeeper/access'
import type { GuideScopeKey, GuideSectionName } from '@holtkeeper/store'

import type { GuideResolver } from './load.ts'
import { type GuideTask, guideSections } from './model.ts'
import type { GuideCaps, GuideLayer, RepoDoc, ResolvedGuide } from './resolve.ts'

/** One numbered layer of a section's Guide chain: the text an agent gets from one source. */
export interface GuideChainLayer {
  /** 1-based, without gaps. */
  n: number
  kind: GuideLayer
  scope?: GuideScopeKey
  source: string
  text: string
  chars: number
  fullChars: number
  cut: boolean
  version?: number
  proposed?: boolean
}

/** One section's layers in agent reading order. */
export interface GuideChainSection {
  section: GuideSectionName
  layers: GuideChainLayer[]
}

/** The layered Guide of a repository, per section, with the budget of what was resolved. */
export interface GuideChain {
  sections: GuideChainSection[]
  budget: GuideCaps & { used: number; humanUsed: number; generatedUsed: number; notesUsed: number }
  warnings: string[]
}

/**
 * The task whose prompt a section's chain stands for: `review` for Review, `release-notes` for
 * Commits and Releases, an agent task otherwise. It picks the notes that apply.
 */
export function chainTaskOf(section: GuideSectionName): GuideTask {
  if (section === 'review') return 'review'
  if (section === 'commits' || section === 'releases') return 'release-notes'
  return 'agent'
}

/**
 * The layers of a resolved Guide in the order the agent reads them (the resolver's block order:
 * repository files, repository rules, family, groups, all, learnings, policies, generated text,
 * notes), numbered from 1; blocks the budget left empty and never had text are dropped.
 */
export function chainLayers(resolved: Pick<ResolvedGuide, 'blocks'>): GuideChainLayer[] {
  return resolved.blocks
    .filter((block) => block.fullChars > 0)
    .map((block, index) => ({
      n: index + 1,
      kind: block.layer,
      ...(block.scope && { scope: block.scope }),
      source: block.source,
      text: block.text,
      chars: block.chars,
      fullChars: block.fullChars,
      cut: block.cut,
      ...(block.version !== undefined && { version: block.version }),
      ...(block.proposed && { proposed: true }),
    }))
}

/**
 * The Guide chain of a repository, built with the same resolver prompts use: each section's
 * layers are that section resolved on its own (`focus`) for the task it stands for
 * (`chainTaskOf`), so they show its text, order and cuts against its own budget. With one section
 * the budget and warnings are those of the whole prompt of its task, which reads the task's other
 * sections too; with several, those of all requested sections resolved together. `sections`
 * defaults to every section.
 */
export async function buildGuideChain(
  resolve: GuideResolver,
  request: {
    repo: RepoTarget
    sections?: readonly GuideSectionName[]
    repoDocs?: readonly RepoDoc[]
  },
): Promise<GuideChain> {
  const wanted = guideSections.filter(
    (section) => !request.sections || request.sections.includes(section),
  )
  const docs = request.repoDocs ? { repoDocs: request.repoDocs } : {}
  const resolved = await Promise.all(
    wanted.map((section) =>
      resolve({ repo: request.repo, task: chainTaskOf(section), focus: [section], ...docs }),
    ),
  )
  const only = wanted.length === 1 ? wanted[0] : undefined
  const whole = only
    ? await resolve({ repo: request.repo, task: chainTaskOf(only), section: only, ...docs })
    : await resolve({ repo: request.repo, task: 'agent', focus: wanted, ...docs })
  return {
    sections: wanted.map((section, index) => ({
      section,
      layers: chainLayers(resolved[index] ?? { blocks: [] }),
    })),
    budget: whole.budget,
    warnings: whole.warnings,
  }
}
