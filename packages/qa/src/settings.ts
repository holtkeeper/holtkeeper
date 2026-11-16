import { z } from 'zod'

/** Setting key of the QA task list of a repository. */
export const qaSettingKey = 'qa'

/**
 * Keys made of a project key and only zeros (`ABC-0`, `ABC-000`): trackers number issues from 1,
 * so such a key never names a real task and is used as a placeholder for "no task".
 */
export const DEFAULT_CATCH_ALL_KEY = '[A-Z][A-Z0-9_]*-0+'

const isPattern = (value: string) => {
  try {
    return RegExp(value, 'u') instanceof RegExp
  } catch {
    return false
  }
}

const pattern = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(isPattern, { message: 'not a valid regular expression' })

/**
 * Which changes of a repository the QA task list reads. Every field has a default, so `{}` is a
 * valid value: on, the default branch plus the release flow's source branch, placeholder keys
 * made of zeros left out.
 */
export const qaSettingsSchema = z.object({
  enabled: z
    .boolean()
    .default(true)
    .describe('List the tasks of this repository under Releases › QA'),
  branches: z
    .array(z.string().trim().min(1))
    .max(10)
    .optional()
    .describe(
      'Branches whose changes are listed, the branch work lands on first; when empty, the branches of the release flow (source, then target) when releases are on, else the default branch',
    ),
  catchAllKeys: z
    .array(pattern)
    .max(50)
    .default([DEFAULT_CATCH_ALL_KEY])
    .describe(
      'Ticket keys used for changes without a real task, as regular expressions matched against the whole key (e.g. `ABC-000` or `[A-Z]+-0+`); changes with only such keys are left out',
    ),
  language: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe('Language of the AI test notes; default: the review language, else English'),
})

/** The `qa` setting of one repository with defaults applied. */
export type QaSettings = z.output<typeof qaSettingsSchema>

/**
 * A stored `qa` value with defaults applied; never throws. A value that does not fit the schema
 * reads as the defaults, so a broken entry never hides the list.
 */
export function qaSettings(value?: unknown): QaSettings {
  const parsed = qaSettingsSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : qaSettingsSchema.parse({})
}

/**
 * Whether a ticket key is a placeholder by `patterns`: each pattern must match the whole key,
 * case-sensitively. Invalid patterns are skipped.
 */
export function catchAllMatcher(patterns: readonly string[]): (key: string) => boolean {
  const compiled = patterns.flatMap((source) => {
    try {
      return [new RegExp(`^(?:${source})$`, 'u')]
    } catch {
      return []
    }
  })
  return (key) => compiled.some((regex) => regex.test(key))
}

const help = `Releases › QA lists the tasks whose changes landed recently, read from the branches of each repository: merged merge requests, open ones and commits pushed without a merge request. Nothing runs until someone opens the page; AI summaries are written only on demand.

- **Branches**: by default the branches of the release flow when releases are on (\`releases\` › flow: the source branch, then the target branch; the target alone in trunk mode), else the default branch. List branches here when a team works on others, the branch work lands on first.
- **Placeholder keys**: changes are grouped by the ticket keys in commit messages, merge request titles and branch names. Keys matching one of \`catchAllKeys\` (whole key, case-sensitive) are ignored, so a key used for years as "no task" does not become one huge task. The default \`${DEFAULT_CATCH_ALL_KEY}\` covers \`ABC-0\`, \`ABC-000\`; a team value replaces the default, so keep it in the list.
- Changes without any other key are left out of the list for now.
- **Language**: AI test notes are written in \`language\`; by default in the review language (\`analyzers.review\` › \`language\`), else English. Test attribute values and established technical terms stay as they are.`

/** The `qa` setting for the settings registry. */
export const qaSettingsDefinition = {
  key: qaSettingKey,
  label: 'QA tasks',
  description:
    'Which branches the QA task list reads, which ticket keys are placeholders and the language of AI test notes.',
  section: 'Releases',
  default: qaSettingsSchema.parse({}),
  schema: qaSettingsSchema,
  help,
}
