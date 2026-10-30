import { allowlistSchema } from '@holtkeeper/vuln'
import { z } from 'zod'

/** A setting that can be set per scope (everything, groups, repository patterns). */
export interface SettingDefinition<Schema extends z.ZodType = z.ZodType> {
  key: string
  label: string
  description: string
  /** Section in the UI, e.g. `AI`, `Audit`. */
  section: string
  schema: Schema
  /**
   * Shape described to editors as JSON Schema when `schema` cannot carry it, e.g. a refined record
   * that checks fields one by one. Defaults to `schema`.
   */
  form?: z.ZodType
  /** Secret values are sealed in storage and never sent back to clients. */
  secret?: boolean
}

export const defineSetting = <Schema extends z.ZodType>(definition: SettingDefinition<Schema>) =>
  definition

export const llmProvider = defineSetting({
  key: 'llm.provider',
  label: 'LLM provider',
  description:
    'AI provider from Credentials used by agentic tasks such as code review and refactoring; its key and endpoint live in the credential.',
  section: 'AI',
  schema: z.string().trim().min(1).meta({ 'x-credential': 'ai-provider' }),
})

export const llmModel = defineSetting({
  key: 'llm.model',
  label: 'Model',
  description:
    'Model id, e.g. claude-opus-5-5, or <prefix>@latest (claude-opus@latest) for the newest version the provider lists.',
  section: 'AI',
  schema: z.string().min(1),
})

export const llmModels = defineSetting({
  key: 'llm.models',
  label: 'Models per task',
  description:
    'Model id per task kind (e.g. review, refactor, triage); tasks without an entry use llm.model.',
  section: 'AI',
  schema: z.record(z.string().min(1), z.string().min(1)),
})

export const llmBudget = defineSetting({
  key: 'llm.budget',
  label: 'AI budget',
  description:
    'Spending limits in USD for agent runs: per UTC month, per UTC day and per task kind (monthly). warn records and continues, block refuses new runs once a limit is reached. The most specific budget for a repository applies together with the global one.',
  section: 'AI',
  schema: z.object({
    monthlyUsd: z.number().positive().optional(),
    dailyUsd: z.number().positive().optional(),
    action: z.enum(['warn', 'block']),
    perTaskKind: z.record(z.string().min(1), z.number().positive()).optional(),
  }),
})

export const agentTools = defineSetting({
  key: 'agent.tools',
  label: 'Agent tools',
  description:
    'Tools for agents: enable the external Context7 docs server, cap the lines a tool result may return and the tokens of team knowledge put into every task (default 1500).',
  section: 'AI',
  schema: z.object({
    context7: z.boolean().optional(),
    maxResultLines: z.number().int().min(10).max(2000).optional(),
    knowledgeTokens: z.number().int().min(0).max(50_000).optional(),
  }),
})

export const reviewInstructions = defineSetting({
  key: 'review.instructions',
  label: 'Review instructions',
  description: 'Extra rules for code review, in Markdown, added to the repository’s own REVIEW.md.',
  section: 'Code review',
  schema: z.string(),
})

export const auditFix = defineSetting({
  key: 'audit.fix',
  label: 'Fix vulnerabilities',
  description: 'Let audits change dependencies and open merge requests with the fixes.',
  section: 'Audit',
  schema: z.boolean(),
})

export const auditUpgrade = defineSetting({
  key: 'audit.upgrade',
  label: 'Largest upgrade',
  description: 'Largest version jump a fix may make. Unset allows major upgrades.',
  section: 'Audit',
  schema: z.enum(['major', 'minor', 'patch']),
})

export const auditAllowlist = defineSetting({
  key: 'audit.allowlist',
  label: 'Allowlist',
  description: 'Advisories to ignore, each with a reason and optionally an expiry date.',
  section: 'Audit',
  schema: allowlistSchema,
})

/** Settings Holtkeeper knows about out of the box; plugins can register more. */
export const builtinSettings: SettingDefinition[] = [
  llmProvider,
  llmModel,
  llmModels,
  llmBudget,
  agentTools,
  reviewInstructions,
  auditFix,
  auditUpgrade,
  auditAllowlist,
]
