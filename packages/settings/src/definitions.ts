import type { KnowledgeKind } from '@holtkeeper/store'
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
  /**
   * Guidance shown next to the editor, in Markdown: what the setting changes, how scopes combine
   * for it and recommended values. `description` stays the one-line summary.
   */
  help?: string
  /**
   * Ready-made values editors can start from. Each value passes `schema`; applied to an object
   * value, a preset sets its own fields and keeps the others.
   */
  presets?: SettingPreset[]
}

/** A named value of a setting, offered by editors as a starting point. */
export interface SettingPreset {
  /** Unique within the setting. */
  id: string
  label: string
  /** One or two sentences on when to pick it. */
  description?: string
  value: unknown
}

export const defineSetting = <Schema extends z.ZodType>(definition: SettingDefinition<Schema>) =>
  definition

export const llmProvider = defineSetting({
  key: 'llm.provider',
  label: 'LLM provider',
  description:
    'AI provider from Credentials used by agentic tasks such as code review and refactoring; its key and endpoint live in the credential.',
  section: 'AI',
  help: `Pick the AI provider credential agents use. The key, endpoint and kind live in **Credentials**, so rotating a key never touches settings.

- Set one provider for **All repositories**, then override it for a group that must use another account (for example a separate budget).
- The provider decides which model ids are valid: set **Model** in the same scope when you switch providers.`,
  schema: z.string().trim().min(1).meta({ 'x-credential': 'ai-provider' }),
})

export const llmModel = defineSetting({
  key: 'llm.model',
  label: 'Model',
  description:
    'Model id, e.g. claude-opus-5-5, or <prefix>@latest (claude-opus@latest) for the newest version the provider lists.',
  section: 'AI',
  help: `The default model for every agent task without its own entry in **Models per task**.

- Use \`<prefix>@latest\` (for example \`claude-opus@latest\`) to follow the newest model the provider lists; pin an exact id when results must stay reproducible.
- A stronger model reviews better but costs more per run: pair it with an **AI budget**.`,
  schema: z.string().min(1),
})

/**
 * Models of task kinds that fit a small model whatever \`llm.model\` says, used when \`llm.models\`
 * has no entry for the kind: issue thread digests of the library docs are short summaries of
 * untrusted text, frequent and cheap.
 */
export const defaultTaskModels: Readonly<Record<string, string>> = {
  'library-digest': 'claude-haiku@latest',
}

export const llmModels = defineSetting({
  key: 'llm.models',
  label: 'Models per task',
  description:
    'Model id per task kind (e.g. review, refactor, triage); tasks without an entry use llm.model.',
  section: 'AI',
  help: `Overrides the model per task kind, for example \`review\`, \`refactor\` or \`triage\`.

- Keep cheap, frequent tasks (\`triage\`, \`library-digest\`) on a small model and reserve the strongest one for \`review\`.
- \`library-digest\` (summaries of library issue threads) uses \`claude-haiku@latest\` without an entry here.
- Other kinds without an entry fall back to **Model**.`,
  schema: z.record(z.string().min(1), z.string().min(1)),
  presets: [
    {
      id: 'balanced',
      label: 'Balanced',
      description:
        'Opus for review and porting, Sonnet for generated changes and summaries, Haiku for triage.',
      value: {
        review: 'claude-opus@latest',
        port: 'claude-opus@latest',
        refactor: 'claude-opus@latest',
        propagate: 'claude-sonnet@latest',
        tests: 'claude-sonnet@latest',
        quality: 'claude-sonnet@latest',
        'release-risk': 'claude-sonnet@latest',
        triage: 'claude-haiku@latest',
        'library-digest': 'claude-haiku@latest',
      },
    },
    {
      id: 'economy',
      label: 'Economy',
      description:
        'Sonnet where judgment matters, Haiku for everything frequent. Roughly a third of the balanced cost.',
      value: {
        review: 'claude-sonnet@latest',
        port: 'claude-sonnet@latest',
        refactor: 'claude-sonnet@latest',
        propagate: 'claude-haiku@latest',
        tests: 'claude-haiku@latest',
        quality: 'claude-haiku@latest',
        'release-risk': 'claude-haiku@latest',
        triage: 'claude-haiku@latest',
        'library-digest': 'claude-haiku@latest',
      },
    },
    {
      id: 'quality',
      label: 'Best quality',
      description: 'Opus for every task except triage. Use with an AI budget.',
      value: {
        review: 'claude-opus@latest',
        port: 'claude-opus@latest',
        refactor: 'claude-opus@latest',
        propagate: 'claude-opus@latest',
        tests: 'claude-opus@latest',
        quality: 'claude-opus@latest',
        'release-risk': 'claude-opus@latest',
        triage: 'claude-haiku@latest',
        'library-digest': 'claude-haiku@latest',
      },
    },
  ],
})

export const llmBudget = defineSetting({
  key: 'llm.budget',
  label: 'AI budget',
  description:
    'Spending limits in USD for agent runs: per UTC month, per UTC day and per task kind (monthly). warn records and continues, block refuses new runs once a limit is reached. The most specific budget for a repository applies together with the global one.',
  section: 'AI',
  help: `Caps what agent runs may spend, in USD.

- **monthlyUsd** and **dailyUsd** count per UTC month and day; **perTaskKind** caps one kind per month.
- **warn** records the overrun and keeps going, **block** refuses new runs until the period resets.
- The global budget always applies; the most specific repository budget applies on top of it. Start with \`warn\` for a week to learn real spend, then switch to \`block\`.`,
  schema: z.object({
    monthlyUsd: z.number().positive().optional(),
    dailyUsd: z.number().positive().optional(),
    action: z.enum(['warn', 'block']),
    perTaskKind: z.record(z.string().min(1), z.number().positive()).optional(),
  }),
  presets: [
    {
      id: 'learn',
      label: 'Learn the spend',
      description: 'Warn above $300 a month or $30 a day without stopping anything.',
      value: { action: 'warn', monthlyUsd: 300, dailyUsd: 30 },
    },
    {
      id: 'small-team',
      label: 'Small team cap',
      description: 'Block new runs above $100 a month or $10 a day.',
      value: { action: 'block', monthlyUsd: 100, dailyUsd: 10 },
    },
    {
      id: 'team',
      label: 'Team cap',
      description: 'Block above $1000 a month or $80 a day; review alone may use $600 a month.',
      value: { action: 'block', monthlyUsd: 1000, dailyUsd: 80, perTaskKind: { review: 600 } },
    },
  ],
})

export const agentTools = defineSetting({
  key: 'agent.tools',
  label: 'Agent tools',
  description:
    'Tools for agents: enable the external Context7 docs server, cap the lines a tool result may return and the tokens of team knowledge put into every task (default 1500).',
  section: 'AI',
  help: `Tunes the tools agents get.

- **context7** lets agents read current library docs from the external Context7 server; leave it off for code that must not leave your network.
- **maxResultLines** trims long tool output; lower it when runs hit context limits.
- **knowledgeTokens** is how much team knowledge goes into every task (default 1500).`,
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
  help: `Extra rules for code review in Markdown, added after the repository's own \`REVIEW.md\`.

- Write rules as short imperative bullets: *"Flag SQL built by string concatenation."*
- Put organization-wide rules on **All repositories** and team conventions on their group; the repository's \`REVIEW.md\` still has the last word.`,
  schema: z.string(),
})

export const agentInstructions = defineSetting({
  key: 'agent.instructions',
  label: 'Agent instructions',
  description:
    'Extra rules for agents per task kind, in Markdown; `*` applies to every task. Put before the task’s own context.',
  section: 'AI',
  help: `Extra rules for agents, keyed by task kind: \`review\`, \`port\`, \`propagate\`, \`tests\`, \`quality\`, \`release-risk\`, \`triage\`, or \`*\` for every task.

- Write rules as short imperative bullets: *"Never bump major versions of react."*
- The most specific entry covering a repository wins as a whole, so a repository entry replaces its group's: repeat the group rules you still want.
- Conventions agents should learn and cite belong in the **Knowledge** base instead; these instructions are for hard rules.`,
  schema: z.record(z.string().min(1), z.string()),
})

export const knowledgeAutoAccept = defineSetting({
  key: 'knowledge.autoAccept',
  label: 'Auto-accept agent knowledge',
  description:
    'Kinds of knowledge entries agents may add without review; other proposals wait on the Knowledge page.',
  section: 'Knowledge',
  help: `Agents propose what they learn while working. Proposals of the kinds listed here are accepted at once and reach later tasks; the rest wait for review on the **Knowledge** page.

- \`quirk\` and \`howto\` are low risk: facts about the code agents found the hard way.
- Keep \`decision\` and \`convention\` under review: they change how agents judge code.
- The scope is the repository the agent worked on, so an entry for a group lets agents learn freely in that group only.`,
  schema: z.array(
    z.enum(['decision', 'convention', 'migration', 'quirk', 'howto'] satisfies KnowledgeKind[]),
  ),
})

export const auditFix = defineSetting({
  key: 'audit.fix',
  label: 'Fix vulnerabilities',
  description: 'Let audits change dependencies and open merge requests with the fixes.',
  section: 'Audit',
  help: `When on, audits change dependency versions and open merge requests with the fixes. When off, they only report.

Turn it on for a pilot group first and watch the merge requests it opens before enabling it everywhere.`,
  schema: z.boolean(),
})

export const auditUpgrade = defineSetting({
  key: 'audit.upgrade',
  label: 'Largest upgrade',
  description: 'Largest version jump a fix may make. Unset allows major upgrades.',
  section: 'Audit',
  help: `The largest version jump a fix may make.

- \`patch\` is the safest and fixes the fewest advisories; \`major\` fixes the most but may break builds.
- \`minor\` is a good default for libraries that follow semantic versioning.`,
  schema: z.enum(['major', 'minor', 'patch']),
})

export const auditAllowlist = defineSetting({
  key: 'audit.allowlist',
  label: 'Allowlist',
  description: 'Advisories to ignore, each with a reason and optionally an expiry date.',
  section: 'Audit',
  help: `Advisories audits should ignore. Give every entry a **reason** reviewers can check and, ideally, an **expiry** date so the exception is revisited.

Prefer a narrow scope: allow an advisory for the one repository that cannot upgrade, not for everything.`,
  schema: allowlistSchema,
})

export const repoReadOnly = defineSetting({
  key: 'repo.readOnly',
  label: 'Read-only',
  description:
    'Only analyze: never comment, review, open merge requests, push or react to merge request events.',
  section: 'Repositories',
  help: `Turn it on for repositories Holtkeeper should only read: shared libraries, vendored code, repositories of other teams.

- Analyses, schedules, tag-triggered jobs and links between repositories keep working.
- Every change through the forge is refused before it is sent: comments, reviews, thread replies, labels, merges, branches, commits, tags, pipeline jobs, deploy keys and project webhooks. Jobs that try one fail with a read-only error.
- Merge request, comment and pipeline events of the repository are ignored, so no policies, reviews or commands run for it.

Set it for everything to make Holtkeeper a pure analytics tool, or for a group or repository pattern only.`,
  schema: z.boolean(),
})

/** Settings Holtkeeper knows about out of the box; plugins can register more. */
export const builtinSettings: SettingDefinition[] = [
  llmProvider,
  llmModel,
  llmModels,
  llmBudget,
  agentTools,
  agentInstructions,
  reviewInstructions,
  knowledgeAutoAccept,
  auditFix,
  auditUpgrade,
  auditAllowlist,
  repoReadOnly,
]
