import type {
  RuleActivation,
  RuleAgent,
  RuleBlock,
  RuleContent,
  RuleInputBody,
  RuleRevision,
  RuleView,
  Scope,
} from '@holtkeeper/api'

import { type TeamTitleOf, keyAsTitle } from './team-titles.ts'

/** Every agent run a rule or learning can target, in display order, with its label. */
export const ruleAgents: readonly { id: RuleAgent; label: string }[] = [
  { id: 'review', label: 'Review' },
  { id: 'task', label: 'Agent task' },
  { id: 'chat', label: 'Chat' },
  { id: 'release', label: 'Release notes' },
]

/** `All` for no limit, else the agents' labels in display order: `Review, Agent task`. */
export function agentsLabel(agents: readonly RuleAgent[] | undefined): string {
  if (!agents?.length) return 'All'
  return ruleAgents
    .filter((agent) => agents.includes(agent.id))
    .map((agent) => agent.label)
    .join(', ')
}

/** A scope in words as Knowledge shows it: `All repositories`, `Team Widgets`, `acme/*\/web`. */
export function ruleScopeLabel(scope: Scope, titleOf: TeamTitleOf = keyAsTitle): string {
  if (scope.all) return 'All repositories'
  const parts = [
    ...(scope.teams?.length ? [`Team ${scope.teams.map(titleOf).join(', ')}`] : []),
    ...(scope.repos ?? []),
  ]
  return parts.join(' · ') || 'No repositories'
}

/**
 * How a rule reaches a prompt, as the server decides it: `files` with path globs, `requested`
 * with only a description (and no Always apply), `always` otherwise.
 */
export function activationOf(
  rule: Pick<RuleContent, 'files' | 'description' | 'alwaysApply'>,
): RuleActivation {
  if (rule.files?.length) return 'files'
  if (rule.description?.trim() && !rule.alwaysApply) return 'requested'
  return 'always'
}

export const activationLabels: Readonly<Record<RuleActivation, string>> = {
  always: 'Always',
  files: 'Files',
  requested: 'On request',
}

/** What the rule editor holds; lists stay lists so tag inputs edit them directly. */
export interface RuleDraft {
  title: string
  body: string
  scope: Scope
  files: string[]
  agents: RuleAgent[]
  description: string
  alwaysApply: boolean
}

export const emptyRuleDraft = (scope: Scope = { all: true }): RuleDraft => ({
  title: '',
  body: '',
  scope,
  files: [],
  agents: [],
  description: '',
  alwaysApply: false,
})

export const ruleDraftOf = (rule: RuleContent): RuleDraft => ({
  title: rule.title,
  body: rule.body,
  scope: rule.scope,
  files: [...(rule.files ?? [])],
  agents: [...(rule.agents ?? [])],
  description: rule.description ?? '',
  alwaysApply: rule.alwaysApply === true,
})

const coversNothing = (scope: Scope) => !scope.all && !scope.teams?.length && !scope.repos?.length

/** What keeps a draft from saving, in words; empty when it may be saved. */
export function ruleDraftProblems(draft: RuleDraft): string[] {
  return [
    ...(draft.title.trim() ? [] : ['Add a title']),
    ...(draft.body.trim() ? [] : ['Write the rule']),
    ...(coversNothing(draft.scope) ? ['Pick a scope'] : []),
  ]
}

/** The request body of a draft; `version` is the version the editor started from. */
export function ruleInputOf(draft: RuleDraft, version?: number): RuleInputBody {
  const description = draft.description.trim()
  return {
    title: draft.title.trim(),
    body: draft.body.trim(),
    scope: draft.scope,
    ...(draft.files.length ? { files: draft.files } : {}),
    ...(draft.agents.length ? { agents: draft.agents } : {}),
    ...(description ? { description } : {}),
    ...(description && draft.alwaysApply ? { alwaysApply: true } : {}),
    ...(version !== undefined ? { version } : {}),
  }
}

/** Saves `revision`'s content over the current `rule`, checked against its version. */
export const restoreRuleInput = (rule: RuleView, revision: RuleRevision): RuleInputBody =>
  ruleInputOf(ruleDraftOf(revision), rule.version)

/** One line of a rule's history: the current version first, then earlier ones. */
export interface RuleVersionRow {
  version: number
  by: string
  at: string
  current: boolean
  revision?: RuleRevision
}

export function ruleVersions(rule: RuleView, history: readonly RuleRevision[]): RuleVersionRow[] {
  return [
    {
      version: rule.version,
      by: rule.updatedBy ?? rule.author,
      at: rule.updatedAt,
      current: true,
    },
    ...history
      .filter((revision) => revision.version !== rule.version)
      .map((revision) => ({
        version: revision.version,
        by: revision.editedBy,
        at: revision.editedAt,
        current: false,
        revision,
      })),
  ]
}

/** Whether a save failed because someone saved the rule in the meantime. */
export const isVersionConflict = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'status' in error && error.status === 409

const blockLayerLabels: Readonly<Record<RuleBlock['layer'], string>> = {
  rule: 'Rule',
  'repo-file': 'Rules file',
  policy: 'Policy',
  learning: 'Learned rule',
}

/** `Rule · All repositories`, `Rules file · AGENTS.md`, with the globs a file-scoped block covers. */
export function blockSubtitle(block: Pick<RuleBlock, 'layer' | 'source' | 'globs'>): string {
  const globs = block.globs?.length ? ` · ${block.globs.join(', ')}` : ''
  return `${blockLayerLabels[block.layer]} · ${block.source}${globs}`
}

/** Touched files typed as one comma- or newline-separated string, trimmed and deduplicated. */
export const parseFiles = (text: string): string[] => [
  ...new Set(
    text
      .split(/[,\n]/)
      .map((file) => file.trim())
      .filter(Boolean),
  ),
]

/** About how many tokens `chars` characters of prompt take. */
export const tokensOf = (chars: number): number => Math.round(chars / 4)

/** Checks a repository-relative path glob typed into a Files field. */
export const validateFileGlob = (glob: string): string | undefined =>
  /\s/.test(glob)
    ? 'Globs cannot contain spaces'
    : glob.startsWith('/')
      ? 'Relative to the repository root, without a leading "/"'
      : undefined

/** What a Knowledge link opens: a rule or learning by id, and the effective prompt of a repository. */
export interface KnowledgeSearch {
  rule?: string
  learning?: string
  /** `forge:path` of the effective prompt's repository; the prompt panel is open when set. */
  prompt?: string
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

/** The Knowledge page's search parameters, dropping unknown and malformed values. */
export function knowledgeSearch(search: Record<string, unknown>): KnowledgeSearch {
  const rule = nonEmpty(search.rule)
  const learning = nonEmpty(search.learning)
  const prompt = typeof search.prompt === 'string' ? search.prompt : undefined
  return {
    ...(rule ? { rule } : {}),
    ...(learning ? { learning } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
  }
}
