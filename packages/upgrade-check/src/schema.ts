import { z } from 'zod'

/** Analyzer kind and analysis kind of the breaking-change check. */
export const UPGRADE_CHECK_KIND = 'upgrade-check'

/** Task kind of the plan and verdict calls: `fast` tier, no tools. */
export const UPGRADE_PLAN_TASK_KIND = 'upgrade-plan'

/** Task kind of the per-area passes: `main` tier, code, git, packages and knowledge tools. */
export const UPGRADE_CHECK_TASK_KIND = 'upgrade-check'

/** Every verdict a check can give, mildest first. */
export const upgradeVerdicts = ['safe', 'review', 'breaking'] as const
/** `safe`: nothing found that breaks; `review`: risky changes to look at; `breaking`: something breaks. */
export type UpgradeVerdict = (typeof upgradeVerdicts)[number]

/** Every finding severity, most severe first. */
export const upgradeSeverities = ['breaking', 'risky', 'info'] as const
/** `breaking`: an upgrade breaks something unless people act; `risky`: may break; `info`: worth knowing. */
export type UpgradeSeverity = (typeof upgradeSeverities)[number]

/** Every finding category. */
export const upgradeCategories = [
  'api',
  'config',
  'data',
  'behavior',
  'dependency',
  'infra',
  'other',
] as const
/** What a finding is about: an API, configuration, stored data, behavior, a dependency, infrastructure or other. */
export type UpgradeCategory = (typeof upgradeCategories)[number]

const pointSchema = z.object({
  ref: z.string(),
  sha: z.string(),
  label: z.string().optional(),
})

const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(upgradeSeverities),
  category: z.enum(upgradeCategories),
  title: z.string(),
  detail: z.string(),
  files: z.array(z.object({ path: z.string(), line: z.number().int().positive().optional() })),
  affects: z.string().optional(),
  check: z.string(),
})

/** Validates stored `upgrade-check` data. */
export const upgradeCheckDataSchema = z.object({
  from: pointSchema,
  to: pointSchema,
  verdict: z.enum(upgradeVerdicts),
  summary: z.string(),
  areas: z.array(
    z.object({ name: z.string(), files: z.number().int().min(0), summary: z.string() }),
  ),
  findings: z.array(findingSchema),
  skipped: z.array(z.object({ files: z.number().int().min(0), reason: z.string() })),
  capped: z.boolean(),
  usage: z
    .object({
      turns: z.number().int().min(0),
      costUsd: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
  durationMs: z.number().min(0).optional(),
})

/**
 * Result of a breaking-change check between two commits of one repository. `from` and `to` carry
 * the ref the check was asked for, the resolved commit and an optional display label. `findings`
 * are deduplicated across areas and sorted by severity; `skipped` counts changed files no agent
 * read, with why; `capped` is true when size limits left files or diff text out.
 */
export type UpgradeCheckData = z.infer<typeof upgradeCheckDataSchema>

/** One finding of a breaking-change check. */
export type UpgradeFinding = UpgradeCheckData['findings'][number]

/** What the agents spent on one check. */
export type UpgradeUsage = NonNullable<UpgradeCheckData['usage']>

const refSchema = z
  .string()
  .min(1)
  .refine((ref) => !ref.startsWith('-'), 'a ref cannot start with "-"')

/** Options of the `upgrade-check` analyzer. Refs never start with `-`. */
export const upgradeCheckOptionsSchema = z.object({
  from: refSchema.describe('Commit sha or tag the installation runs now'),
  to: refSchema.describe('Commit sha or tag it upgrades to; jobs check it out'),
  fromLabel: z.string().min(1).optional(),
  toLabel: z.string().min(1).optional(),
  apiChanges: z
    .string()
    .optional()
    .describe('Markdown of the public API changes of the range, computed by the caller'),
  dependencyChanges: z
    .string()
    .optional()
    .describe('Markdown of the dependency changes of the range, computed by the caller'),
  commits: z
    .array(z.string())
    .optional()
    .describe('Commit subjects of the range; read from git when absent'),
  costLimitUsd: z.coerce
    .number()
    .min(0)
    .optional()
    .describe(
      'Soft spend limit of one check in USD: area passes that reach their share answer with what they found (default 6). 0 turns it off.',
    ),
})

/** Validated options of the `upgrade-check` analyzer. */
export type UpgradeCheckOptions = z.infer<typeof upgradeCheckOptionsSchema>

/**
 * The stored record's `ref` of a check between two commits: `<fromSha>..<toSha>`, so a later
 * request for the same range finds it.
 */
export const upgradeCheckRef = (fromSha: string, toSha: string): string => `${fromSha}..${toSha}`
