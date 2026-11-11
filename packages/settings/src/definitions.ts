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
  /** Only one value for every repository: entries must have the scope `{ all: true }`. */
  global?: boolean
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
  label: 'AI provider',
  description:
    'AI provider from Credentials used by every agent task; its key and endpoint live in the credential.',
  section: 'AI',
  global: true,
  help: `Pick the AI provider credential agents use. The key, endpoint and kind live in **Credentials**, so rotating a key never touches settings.

- One provider serves every repository; its credential scope must cover the repositories agents work on.
- Models are not configured: tasks run on fixed tiers, resolved to the newest models the provider lists. Summaries and classification use Haiku, reviews, replies and changes use Sonnet, deep reviews use Opus.`,
  schema: z.string().trim().min(1).meta({ 'x-credential': 'ai-provider' }),
})

export const llmBudget = defineSetting({
  key: 'llm.budget',
  label: 'AI budget',
  description:
    'Weekly spending limit in USD for agent runs, from Monday 00:00 in the instance time zone, with a reserve only work a person started may use. block refuses runs that would go over it and stops runs that reach it, warn only records. Default $150 a week with a $25 reserve.',
  section: 'AI',
  help: `Caps what agent runs may spend each week, in USD. The week starts on Monday 00:00 in the instance time zone.

- **weeklyUsd** (default 150) is the limit for the week.
- **reserveUsd** (default 25) is kept for work a person started (a click in the panel, chat, a command on a merge request). Automatic work (schedules, triggers, webhooks) stops at \`weeklyUsd - reserveUsd\`.
- A run is refused when this week's spend plus its expected cost would go over its limit, and a running agent stops once it spends what is left.
- **block** (default) refuses and stops runs; refused jobs show as blocked by budget. **warn** only records the overrun.
- Without a global budget the defaults apply to everything. The most specific repository budget applies on top of the global one.`,
  schema: z.object({
    weeklyUsd: z.number().positive().default(150),
    reserveUsd: z.number().min(0).default(25),
    action: z.enum(['block', 'warn']).default('block'),
  }),
  presets: [
    {
      id: 'default',
      label: 'Weekly cap',
      description: 'Block above $150 a week; the last $25 is kept for work people start.',
      value: { weeklyUsd: 150, reserveUsd: 25, action: 'block' },
    },
    {
      id: 'learn',
      label: 'Learn the spend',
      description: 'Warn above $150 a week without stopping anything.',
      value: { weeklyUsd: 150, reserveUsd: 25, action: 'warn' },
    },
    {
      id: 'small-team',
      label: 'Small team cap',
      description: 'Block above $40 a week; the last $10 is kept for work people start.',
      value: { weeklyUsd: 40, reserveUsd: 10, action: 'block' },
    },
  ],
})

export const agentTools = defineSetting({
  key: 'agent.tools',
  label: 'Agent tools',
  description: 'Tokens of team knowledge put into every agent task (default 1500).',
  section: 'AI',
  help: `Tunes what agents get with every task.

- **knowledgeTokens** is how much team knowledge goes into every task (default 1500); \`0\` leaves it out.`,
  schema: z.object({
    knowledgeTokens: z.number().int().min(0).max(50_000).optional(),
  }),
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

/** Value of `tasks.write`; every field has a default, so `{ enabled: true }` is enough. */
export const tasksWriteSchema = z.object({
  enabled: z.boolean().default(false),
  /** Spend cap of one task on one repository. */
  perRepoUsd: z.number().positive().max(5).default(1.5),
  /** Spend cap of one task over all its repositories. */
  perGroupUsd: z.number().positive().max(50).default(5),
  /** Write task spend per week; no new task starts once it is reached. */
  weeklyUsd: z.number().positive().max(150).default(40),
  /** Repositories one task may change at most. */
  maxRepos: z.number().int().min(1).max(50).default(10),
})

export type TasksWrite = z.infer<typeof tasksWriteSchema>

export const tasksWrite = defineSetting({
  key: 'tasks.write',
  label: 'Write tasks',
  description:
    'Whether agents may change code: push a branch and open a merge request. Off until an admin turns it on.',
  section: 'AI',
  global: true,
  help: `Write tasks let an agent change code in a fresh checkout, run the repository's own checks, push a branch \`holtkeeper/<task>-<slug>\` and open a draft merge request. They never merge.

- **enabled** (default off): the switch for the whole instance. Turning it off stops tasks that have not started yet; queued tasks fail with a refusal.
- **perRepoUsd** (default 1.5) and **perGroupUsd** (default 5): spend caps of one task, per repository and over all its repositories, retries and added repositories included.
- **weeklyUsd** (default 40): approving refuses work whose caps, added to this week's write task spend and the caps of tasks still queued or running, would pass it; a task that starts once the spend reached it stops as a budget stop.
- **maxRepos** (default 10): repositories one task may change.

Tasks run only on dedicated write workers (\`serve --pool write\`, with \`jobs.execution.mode\` \`mise\` or \`container\`), need \`tasks:run\` on every repository they change, and refuse read-only repositories. The panel edits this setting in Settings → System → Write tasks.`,
  schema: tasksWriteSchema,
})

/** Levels of `access.crossTeam`, from narrowest to widest. */
export const crossTeamLevels = ['off', 'metadata', 'snippets'] as const

export type CrossTeamCatalog = (typeof crossTeamLevels)[number]

/** What `access.crossTeam` is when nobody set it. */
export const defaultCrossTeam: CrossTeamCatalog = 'snippets'

export const accessCrossTeam = defineSetting({
  key: 'access.crossTeam',
  label: 'Cross-team catalog',
  description:
    "How much of other teams' repositories people and agents may read: package inventory, public API, stack and shared notes (metadata), plus usage snippets (snippets), or nothing (off). Default snippets.",
  section: 'Access',
  global: true,
  help: `Lets people and agents learn from other teams without seeing their findings, jobs or releases.

- **metadata**: anyone who may read some repository also reads every repository's package and version inventory, public API, stack and tool versions, usage counts and knowledge notes marked *shared*. Agents (reviews, chat, Guide, MCP tokens) get the same reach; chat replies stay within what the asker may read.
- **snippets** (default): metadata plus the code snippets of how other teams use a package (\`find_usages\`, upgrade call sites).
- **off**: everyone sees only the repositories their grants cover; agents without an asker stay within the teams of the repository they work on.

Pages still show your team first and fold other teams into a collapsed section.`,
  schema: z.enum(crossTeamLevels),
})

/** Settings Holtkeeper knows about out of the box; plugins can register more. */
export const builtinSettings: SettingDefinition[] = [
  llmProvider,
  llmBudget,
  agentTools,
  knowledgeAutoAccept,
  auditFix,
  auditUpgrade,
  auditAllowlist,
  repoReadOnly,
  accessCrossTeam,
  tasksWrite,
]
