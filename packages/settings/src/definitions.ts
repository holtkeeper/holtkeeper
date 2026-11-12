import type { GuideSectionName, KnowledgeKind } from '@holtkeeper/store'
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
   * What applies to a repository no entry covers, as the code that reads the setting sees it;
   * `null` when nothing applies until someone sets it. A non-null default passes `schema`.
   */
  default: z.output<Schema> | null
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
  /**
   * Value keys (dotted paths) that moved to another setting, with where they live now, e.g.
   * `{ ignore: 'assets.policy › ignore' }`. Stored values still carrying them are flagged by
   * `unknownSettingKeys` with that hint; nothing migrates them.
   */
  movedKeys?: Record<string, string>
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
  default: null,
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
- **warnPercent** (default 80) is the share of \`weeklyUsd\` at which the budget shows as close to the limit. People who may change the budget then get one Inbox item for that week; it never blocks.
- Without a global budget the defaults apply to everything. The most specific repository budget applies on top of the global one.`,
  default: { weeklyUsd: 150, reserveUsd: 25, action: 'block', warnPercent: 80 },
  schema: z.object({
    weeklyUsd: z.number().positive().default(150),
    reserveUsd: z.number().min(0).default(25),
    action: z.enum(['block', 'warn']).default('block'),
    warnPercent: z.number().int().min(1).max(100).default(80),
  }),
  presets: [
    {
      id: 'default',
      label: 'Weekly cap',
      description: 'Block above $150 a week; the last $25 is kept for work people start.',
      value: { weeklyUsd: 150, reserveUsd: 25, action: 'block', warnPercent: 80 },
    },
    {
      id: 'learn',
      label: 'Learn the spend',
      description: 'Warn above $150 a week without stopping anything.',
      value: { weeklyUsd: 150, reserveUsd: 25, action: 'warn', warnPercent: 80 },
    },
    {
      id: 'small-team',
      label: 'Small team cap',
      description: 'Block above $40 a week; the last $10 is kept for work people start.',
      value: { weeklyUsd: 40, reserveUsd: 10, action: 'block', warnPercent: 80 },
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
  default: { knowledgeTokens: 1500 },
  schema: z.object({
    knowledgeTokens: z.number().int().min(0).max(50_000).optional(),
  }),
})

export const knowledgeAutoAccept = defineSetting({
  key: 'knowledge.autoAccept',
  label: 'Auto-accept agent knowledge',
  description:
    'Kinds of knowledge entries agents may add without review; other proposals wait in Knowledge › Notes.',
  section: 'Knowledge',
  help: `Agents propose what they learn while working. Proposals of the kinds listed here are accepted at once and reach later tasks; the rest wait for review in Knowledge › Notes.

- \`quirk\` and \`howto\` are low risk: facts about the code agents found the hard way.
- Keep \`decision\` and \`convention\` under review: they change how agents judge code.
- The scope is the repository the agent worked on, so an entry for a group lets agents learn freely in that group only.`,
  default: [],
  schema: z.array(
    z.enum(['decision', 'convention', 'migration', 'quirk', 'howto'] satisfies KnowledgeKind[]),
  ),
})

/** Where `learnings.autoAccept` comes from: rules MCP clients propose, rules learned from review replies. */
export const learningAutoAcceptSources = ['mcp', 'review-reply'] as const

export type LearningAutoAcceptSource = (typeof learningAutoAcceptSources)[number]

/** Value of `learnings.autoAccept`. */
export const learningsAutoAcceptSchema = z.object({
  /** Origins of candidates accepted without review; empty keeps every candidate proposed. */
  sources: z.array(z.enum(learningAutoAcceptSources)).default([]),
  /**
   * `suggested`: the candidate's target scope, else the scope its suggested kind points at;
   * `repo`: always the candidate's repository.
   */
  scope: z.enum(['suggested', 'repo']).default('suggested'),
})

export type LearningsAutoAccept = z.output<typeof learningsAutoAcceptSchema>

export const learningsAutoAccept = defineSetting({
  key: 'learnings.autoAccept',
  label: 'Auto-accept learnings',
  description:
    'Rule candidates accepted into the Guide without review, by where they come from; the rest wait in Knowledge › Learnings.',
  section: 'Knowledge',
  help: `Learned rules reach every agent prompt of the scope they are accepted into. By default each candidate waits for a person in Knowledge › Learnings.

- **sources**: \`mcp\` accepts rules MCP clients propose with \`propose_rule_change\`, but only from people who may edit the repository's knowledge (\`knowledge:write\`); proposals of mere readers stay for review. \`review-reply\` accepts rules extracted from replies to review comments, from anyone who replies on the repository's merge requests. Empty (default) accepts nothing.
- **scope**: \`suggested\` (default) accepts into the scope the proposer named, else the nearest group, family or the repository as suggested, but never wider than this entry's own scope: an entry on a repository or subgroup accepts a rule meant for a parent group or family into the repository. \`repo\` always accepts into the candidate's repository only.
- The entry that applies to the candidate's repository decides. Auto-accepted rules show as accepted by *Auto-accept* and in History; reject one in Knowledge › Learnings to take it out of the Guide.`,
  default: { sources: [], scope: 'suggested' },
  schema: learningsAutoAcceptSchema,
})

/** Guide sections the generator writes, which `guide.autoAccept` may list. */
export const generatedGuideSections = [
  'general',
  'testing',
  'testids',
  'commits',
] as const satisfies readonly GuideSectionName[]

export const guideAutoAccept = defineSetting({
  key: 'guide.autoAccept',
  label: 'Auto-accept generated Guide',
  description:
    'Guide sections whose generated text agents use as soon as the guide job writes it, without review.',
  section: 'Knowledge',
  help: `The guide job writes each section from repository signals as a proposal; agents keep the accepted text until a person accepts the new one.

- Sections listed here are accepted when the job writes them, as *Auto-accept*, and audited.
- Rejecting auto-accepted text in Knowledge › Guide puts back the text a person accepted before, or removes the generated layer, and the same inputs are not proposed again.
- \`commits\` is built without an LLM from the repository's history and rules; \`general\` changes most of what agents read.`,
  default: [],
  schema: z.array(z.enum(generatedGuideSections)),
})

export const auditFix = defineSetting({
  key: 'audit.fix',
  label: 'Fix vulnerabilities',
  description: 'Let audits change dependencies and open merge requests with the fixes.',
  section: 'Audit',
  help: `When on, audits change dependency versions and open merge requests with the fixes. When off, they only report.

Turn it on for a pilot group first and watch the merge requests it opens before enabling it everywhere.`,
  default: false,
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
  default: 'major',
  schema: z.enum(['major', 'minor', 'patch']),
})

export const auditAllowlist = defineSetting({
  key: 'audit.allowlist',
  label: 'Allowlist',
  description: 'Advisories to ignore, each with a reason and optionally an expiry date.',
  section: 'Audit',
  help: `Advisories audits should ignore. Give every entry a **reason** reviewers can check and, ideally, an **expiry** date so the exception is revisited.

Prefer a narrow scope: allow an advisory for the one repository that cannot upgrade, not for everything.`,
  default: [],
  schema: allowlistSchema,
})

/** Value of `audit.allowlistPolicy`: limits on the entries people add to `audit.allowlist`. */
export const allowlistPolicySchema = z.object({
  /** Longest an entry may stay before it expires, in days; unset allows entries without expiry. */
  maxDays: z.number().int().min(1).max(3650).optional(),
  /** New and renewed entries must say why the advisory is accepted. */
  requireReason: z.boolean().default(true),
})

export type AllowlistPolicy = z.infer<typeof allowlistPolicySchema>

export const auditAllowlistPolicy = defineSetting({
  key: 'audit.allowlistPolicy',
  label: 'Allowlist rules',
  description:
    'Limits on allowlist entries: how many days an entry may last at most and whether it needs a reason.',
  section: 'Audit',
  help: `Keeps the allowlist honest.

- **maxDays**: new and renewed entries must expire within this many days. Unset allows entries without an expiry date.
- **requireReason** (default on): new and renewed entries must say why the advisory is accepted.

Entries already stored are not changed; the limits apply the next time someone adds or renews one.`,
  default: { requireReason: true },
  schema: allowlistPolicySchema,
})

/**
 * Value of `repo.freeze`: whether Holtkeeper must not change the repository (`frozen`, default
 * `true`), why, and optionally the moment the entry stops counting. A frozen entry needs a reason;
 * on a lift (`frozen: false`, which lifts a broader freeze for its scope) an empty one is dropped.
 * Without `until` it lasts until removed.
 */
export const repoFreezeSchema = z
  .object({
    frozen: z.boolean().default(true),
    reason: z.string().trim().max(500).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((value) => !value.frozen || !!value.reason, {
    message: 'a freeze needs a reason',
    path: ['reason'],
  })
  .transform(({ reason, ...rest }): typeof rest & { reason?: string } =>
    reason ? { ...rest, reason } : rest,
  )

/** A parsed `repo.freeze` value; `frozen` is always set. */
export type RepoFreeze = z.infer<typeof repoFreezeSchema>

/** Per-repository `repo.freeze` setting: the most specific entry in force wins. */
export const repoFreeze = defineSetting({
  key: 'repo.freeze',
  label: 'Read-only',
  description:
    'Only analyze, with a reason and an optional end: never comment, review, open merge requests, push or react to merge request events.',
  section: 'Repositories',
  help: `Add repositories Holtkeeper should only read: shared libraries, vendored code, repositories of other teams, a code freeze.

- **frozen** (default on): off makes the entry a lift, so its scope stays writable under a broader freeze.
- **reason** says why, so others know whom to ask before changing it. A freeze needs one; on a lift it is recommended and shown as "Writable here: <reason>".
- Anyone who may change settings of a group or repository can lift a broader freeze there, including one set for everything: a lift is an ordinary entry, and the most specific entry wins.
- **until** ends the entry at that moment; leave it empty for one that lasts until the entry is removed. An entry past its end no longer counts, and the next broader entry applies again.
- Analyses, schedules, tag-triggered jobs and links between repositories keep working.
- Every change through the forge is refused before it is sent: comments, reviews, thread replies, labels, merges, branches, commits, tags, pipeline jobs, deploy keys and project webhooks. Jobs that try one fail with a read-only error.
- Merge request, comment and pipeline events of the repository are ignored, so no policies, reviews or commands run for it.

Set it for everything to make Holtkeeper a pure analytics tool, or for a group or repository pattern only. The most specific entry wins, so a repository entry with frozen off keeps one repository of a frozen group writable.`,
  default: null,
  schema: repoFreezeSchema,
  form: z
    .object({
      frozen: z.boolean().default(true),
      reason: z.string().max(500),
      until: z.iso.datetime({ offset: true }).optional(),
    })
    .default({ frozen: true, reason: '' }),
})

/**
 * Value of `repo.tests`: whether the repository is meant to have tests and, when it is not, why.
 * The most specific entry wins, so a repository entry can turn tests back on under a group.
 */
export const repoTestsSchema = z.object({
  expected: z.boolean().default(true),
  reason: z.string().trim().min(1).max(500).optional(),
})

/** A parsed `repo.tests` value; `expected` is always set, `reason` only when given. */
export type RepoTests = z.infer<typeof repoTestsSchema>

/** Per-repository `repo.tests` setting: the most specific entry wins; tests are expected by default. */
export const repoTests = defineSetting({
  key: 'repo.tests',
  label: 'Tests',
  description:
    'Whether repositories are meant to have tests. Off marks them as having no tests by design: coverage is skipped and agents neither write nor ask for tests.',
  section: 'Repositories',
  help: `Turn tests off for repositories that have no tests by design: configuration, documentation, prototypes, generated code.

- **expected** (default on): off marks the covered repositories as having no tests by design.
- **reason** says why; the panel shows it wherever it says "No tests by design".

Set it for everything, a group or a repository pattern. The most specific entry wins, so a repository entry with tests on lifts a group entry with tests off.

When tests are off:
- Coverage is never queued automatically (events, new repositories, freshness, schedules), counts as skipped in Ops › Automation and leaves repository freshness; a manual run still goes ahead. Quality › Coverage, repository health and the repository overview show "No tests by design" instead of a coverage figure.
- The Guide drops its Testing section for the repository, the Guide generator skips it, and agents are told not to add or run tests.
- AI reviews never ask for tests (test-id comments still come), write tasks and propagation fixes leave out test checks, and test write tasks are refused, also when proposed before tests were turned off.

Test ids (\`analyzers.testids\`) are unaffected: end-to-end suites in other repositories read them.`,
  default: { expected: true },
  schema: repoTestsSchema,
})

/**
 * Value of `repo.analyzers`: analyzer kinds that never run automatically on the repository and,
 * optionally, why. The most specific entry wins, so `{ off: [] }` turns them back on underneath.
 */
export const repoAnalyzersSchema = z.object({
  off: z.array(z.string().trim().min(1)).max(100).default([]),
  reason: z.string().trim().min(1).max(500).optional(),
})

/** A parsed `repo.analyzers` value; `off` is always set, `reason` only when given. */
export type RepoAnalyzers = z.infer<typeof repoAnalyzersSchema>

/** Key of the per-repository `repo.analyzers` setting. */
export const repoAnalyzersKey = 'repo.analyzers'

/** An analyzer `repo.analyzers` may turn off: its kind and the name people see. */
export interface SwitchableAnalyzer {
  kind: string
  label: string
}

/**
 * The `repo.analyzers` definition for the analyzers a server runs: `off` accepts only their kinds,
 * labelled for editors with `x-labels`. Register it next to the built-in settings.
 */
export function repoAnalyzersSetting(analyzers: readonly SwitchableAnalyzer[]) {
  const kinds = [...new Set(analyzers.map((analyzer) => analyzer.kind))]
  const labels = Object.fromEntries(analyzers.map((analyzer) => [analyzer.kind, analyzer.label]))
  const [first, ...rest] = kinds
  const kind =
    first === undefined ? z.never() : z.enum([first, ...rest]).meta({ 'x-labels': labels })
  return defineSetting({
    key: repoAnalyzersKey,
    label: 'Analyzers off',
    description:
      'Analyzers that never run automatically on the covered repositories, with a reason. Their results show as off instead of missing or stale.',
    section: 'Repositories',
    help: `Turn analyzers off for repositories they make no sense for: a vulnerability audit of a values-only repository, bundle sizes of a library without a build.

- **off**: the analyzer kinds to leave out. Leave it empty in a narrower entry to turn every analyzer back on there.
- **reason** says why; the panel shows it wherever it says "Off".

Set it for everything, a group or a repository pattern. The most specific entry wins as a whole, so repeat kinds a narrower entry should keep off.

For an analyzer that is off:
- It is never queued automatically (events, triggers, schedules, freshness, new repositories) and counts as skipped in Ops › Automation; a manual run still goes ahead.
- Repository health and the repository overview show "Off" instead of a result, and its stale records leave repository freshness.
- An audit that is off leaves Supply › Security (findings, latest runs, the fleet figures), the advisories of Supply › Libraries and of the MCP tool \`evaluate_dependency\`, and Needs attention on Home; other analyzers leave the stale-analysis items there.`,
    default: { off: [] },
    schema: repoAnalyzersSchema.extend({
      off: z.array(kind).max(100).default([]),
    }),
  })
}

/**
 * Value of `mergeRequests.comments`: whether Holtkeeper reviews and comments on merge requests of
 * the repository and, when it does not, why. The most specific entry wins.
 */
export const mergeRequestCommentsSchema = z.object({
  enabled: z.boolean().default(true),
  reason: z.string().trim().min(1).max(500).optional(),
})

/** A parsed `mergeRequests.comments` value; `enabled` is always set, `reason` only when given. */
export type MergeRequestComments = z.infer<typeof mergeRequestCommentsSchema>

/** Per-repository `mergeRequests.comments` setting: the most specific entry wins; on by default. */
export const mergeRequestComments = defineSetting({
  key: 'mergeRequests.comments',
  label: 'Merge request reviews',
  description:
    'Whether Holtkeeper reviews and comments on merge requests. Off: no AI review runs and nothing is posted on merge requests of the covered repositories.',
  section: 'Merge requests',
  help: `Turn merge request reviews off for repositories whose teams do not want Holtkeeper in their merge requests.

- **enabled** (default on): off stops reviews and merge request comments in the covered repositories.
- **reason** says why, for whoever wonders where the reviews went.

Set it for everything, a group or a repository pattern. The most specific entry wins, so a repository entry that is on lifts a group entry that is off.

When it is off:
- The AI review is never queued: not on merge request events, labels, policies, \`/holtkeeper\` commands, replies to review threads or task review requests.
- Holtkeeper posts nothing on the repository's merge requests: no comments, review threads, thread replies, resolved threads, command answers, and merge request policies skip their comment and label actions.
- Merge request policies still approve, merge, close or queue other analyzers, and analyses of the default branch keep running.
- Merge requests Holtkeeper opens itself (tasks, propagation, renovate, release candidates) still carry their own title, description and labels.

Unlike **Read-only** (\`repo.freeze\`), which refuses every change through the forge (branches, commits, merge requests, tags) and ignores merge request events, this only keeps reviews and comments off merge requests.`,
  default: { enabled: true },
  schema: mergeRequestCommentsSchema,
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

Tasks run only on dedicated write workers (\`serve --pool write\`, with \`jobs.execution.mode\` \`mise\` or \`container\`), need \`tasks:run\` on every repository they change, and refuse read-only repositories. The panel edits this setting in Ops › Tasks.`,
  default: tasksWriteSchema.parse({}),
  schema: tasksWriteSchema,
})

/** Levels of `access.crossTeam`, from narrowest to widest. */
export const crossTeamLevels = ['off', 'metadata', 'snippets'] as const

export type CrossTeamCatalog = (typeof crossTeamLevels)[number]

/** What `access.crossTeam` is when nobody set it. */
export const defaultCrossTeam: CrossTeamCatalog = 'snippets'

export const accessCrossTeam = defineSetting({
  key: 'access.crossTeam',
  label: 'Reach',
  description:
    "What everyone may read of other teams' repositories: nothing (off), the catalog (metadata) or the catalog with usage code (snippets). One level for the whole instance, without exceptions. Default snippets.",
  section: 'Access',
  global: true,
  help: `How far people and agents see past their own teams. Grants still decide everything else: other teams' findings, jobs, merge requests and releases stay hidden at every level.

- **off**: only the repositories a person's grants cover. Agents working without an asker stay within the teams of the repository they work on.
- **metadata**: anyone who may read some repository also reads every repository's package and version inventory, public API, stack and tool versions, usage counts and knowledge notes marked *shared*. Agents (reviews, chat, Guide, MCP tokens) get the same reach; chat replies stay within what the asker may read.
- **snippets** (default): metadata plus the code of how other teams use a package (\`find_usages\`, upgrade call sites).

The level applies to every person, team and agent alike; there are no per-team exceptions. Pages show your teams first and fold other teams into a collapsed section.`,
  default: defaultCrossTeam,
  schema: z.enum(crossTeamLevels).meta({
    'x-labels': {
      off: 'Own teams only',
      metadata: 'Catalog of every team',
      snippets: 'Catalog and usage code of every team',
    },
  }),
})

/** Settings Holtkeeper knows about out of the box; plugins can register more. */
export const builtinSettings: SettingDefinition[] = [
  llmProvider,
  llmBudget,
  agentTools,
  knowledgeAutoAccept,
  learningsAutoAccept,
  guideAutoAccept,
  auditFix,
  auditUpgrade,
  auditAllowlist,
  auditAllowlistPolicy,
  repoFreeze,
  repoTests,
  mergeRequestComments,
  accessCrossTeam,
  tasksWrite,
]
