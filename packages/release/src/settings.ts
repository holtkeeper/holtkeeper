import { z } from 'zod'

/** Setting key of the release flow of a repository. */
export const releaseSettingsKey = 'releases'

/** Setting key of where release events are announced. */
export const releaseNotifySettingKey = 'releases.notify'

const bump = z.enum(['major', 'minor', 'patch', 'none'])

const weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')

const section = z.enum([
  'breaking',
  'features',
  'fixes',
  'performance',
  'refactoring',
  'reverts',
  'docs',
  'tests',
  'build',
  'chores',
  'other',
])

const validPattern = (pattern: string) => {
  try {
    return RegExp(pattern, 'iu') instanceof RegExp
  } catch {
    return false
  }
}

const validZone = (zone: string) => {
  try {
    return Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone !== ''
  } catch {
    return false
  }
}

/** Default merge request description; placeholders are listed in the package docs. */
export const defaultRequestDescription = `{summary}

{changelog}

Next version if released now: **{next}**`

/** Default notes of a forge release. */
export const defaultReleaseNotes = `{summary}

{changelog}`

const environment = z.object({
  name: z.string().trim().min(1).describe('Environment name, e.g. preprod'),
  job: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Pipeline job that deploys it (glob); the environment name when empty'),
  after: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Environment that must be deployed successfully first'),
  confirm: z.boolean().default(true).describe('Ask before starting the job'),
  auto: z
    .boolean()
    .default(false)
    .describe('Start without a person: after the version is created, or once `after` succeeded'),
})

const freezeWindow = z.object({
  days: z.array(weekday).optional().describe('Days of the week; every day when empty'),
  from: clock.optional().describe('Start time in the release time zone'),
  to: clock.optional().describe('End time in the release time zone'),
  reason: z.string().optional(),
})

/**
 * How one repository releases: where changes come from, how versions are named and bumped, what
 * goes into the changelog, what signals that a candidate is accepted, and how deploys run. Every
 * field has a default, so `{}` is a valid value (merge request flow, semver, `v{version}` tags).
 */
export const releaseSettingsSchema = z.object({
  enabled: z.boolean().default(true).describe('Show the repository on the release board'),
  flow: z
    .object({
      mode: z
        .enum(['merge-request', 'trunk', 'external'])
        .default('merge-request')
        .describe(
          '`merge-request`: a merge request brings `source` into `target`, versions are tagged on `target`; `trunk`: work lands on `target` directly; `external`: another tool releases, Holtkeeper only shows it',
        ),
      source: z.string().trim().min(1).default('development').describe('Branch changes come from'),
      target: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Branch versions are tagged on; the default branch when empty'),
    })
    .prefault({}),
  version: z
    .object({
      scheme: z.enum(['semver', 'calver']).default('semver'),
      tagFormat: z
        .string()
        .includes('{version}', { message: 'must contain {version}' })
        .default('v{version}')
        .describe('Tag name around the version, e.g. v{version} or release-{version}'),
      calver: z
        .string()
        .regex(/MICRO/, 'must contain MICRO')
        .default('YYYY.0M.MICRO')
        .describe('Calendar version format: YYYY, YY, 0M, MM, 0D, DD and MICRO'),
      initial: z.string().default('0.1.0').describe('First semantic version when no tag exists'),
      prerelease: z
        .string()
        .regex(/^[0-9A-Za-z-]+$/)
        .optional()
        .describe('Pre-release channel, e.g. rc: versions become 1.2.0-rc.1, rc.2, ...'),
      bump: z
        .object({
          types: z
            .record(z.string(), bump)
            .default({ feat: 'minor', fix: 'patch', perf: 'patch', revert: 'patch' })
            .describe('Bump per conventional commit type'),
          other: bump.default('patch').describe('Bump for commits of other types or none'),
          breaking: bump.default('major'),
          initialDevelopment: bump
            .default('minor')
            .describe('Bump for breaking changes while the major version is 0'),
          labels: z
            .record(z.string(), bump)
            .default({})
            .describe('Merge request labels that force a bump, e.g. release:major'),
          minimum: bump.default('patch').describe('Least bump when anything is released'),
        })
        .prefault({}),
    })
    .prefault({}),
  changelog: z
    .object({
      merges: z
        .enum(['exclude', 'include', 'only'])
        .default('exclude')
        .describe('Merge commits: left out, listed with the rest, or the only entries'),
      excludeTypes: z.array(z.string()).default([]).describe('Commit types left out, e.g. ci'),
      exclude: z
        .array(z.string().refine(validPattern, 'invalid regular expression'))
        .default([])
        .describe('Regular expressions; matching commit subjects are left out'),
      sections: z.array(section).optional().describe('Only these sections; all when empty'),
      revertPairs: z
        .boolean()
        .default(true)
        .describe('Leave out a commit and its revert when both are in the release'),
      groupBy: z.enum(['section', 'scope', 'ticket', 'none']).default('section'),
      links: z.boolean().default(true).describe('Link tickets, merge requests and commits'),
      authors: z.boolean().default(false).describe('Name the authors of each entry'),
      ticketUrl: z
        .string()
        .optional()
        .describe('Tracker URL with {id}, e.g. https://jira.example.com/browse/{id}'),
    })
    .prefault({}),
  summary: z
    .object({
      mode: z
        .enum(['agent', 'changelog', 'off'])
        .default('changelog')
        .describe('Who writes "what changed": the AI agent, a digest of the changelog, nobody'),
      audience: z.enum(['qa', 'users', 'developers', 'managers']).default('qa'),
      language: z.string().default('English'),
      instructions: z.string().optional().describe('Extra rules for the agent, in Markdown'),
    })
    .prefault({}),
  mergeRequest: z
    .object({
      title: z.string().min(1).default('Release candidate {date}'),
      description: z.string().default(defaultRequestDescription),
      labels: z.array(z.string()).default([]),
      reviewers: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
      autoUpdate: z
        .boolean()
        .default(true)
        .describe('Rewrite the description when new commits reach the source branch'),
    })
    .prefault({}),
  acceptance: z
    .object({
      required: z
        .boolean()
        .default(false)
        .describe('A version can only be created once the changes are accepted'),
      signals: z
        .array(z.enum(['manual', 'label', 'merge']))
        .default(['manual', 'label'])
        .describe(
          'What accepts changes on the target branch: a person in Holtkeeper (or its API), a label on the merged merge request, or the merge itself',
        ),
      label: z.string().trim().min(1).default('release-accepted'),
      autoVersion: z
        .boolean()
        .default(false)
        .describe('Create the version as soon as the changes are accepted'),
    })
    .prefault({}),
  tag: z
    .object({
      message: z.string().default('Release {version}').describe('Annotated tag message'),
      release: z.boolean().default(true).describe('Also create a forge release with the notes'),
      releaseName: z.string().default('{tag}'),
      notes: z.string().default(defaultReleaseNotes),
      changelogFile: z
        .object({
          enabled: z.boolean().default(false),
          path: z.string().trim().min(1).default('CHANGELOG.md'),
          heading: z.string().default('## {version} ({date})'),
          message: z.string().default('chore(release): {version}'),
        })
        .prefault({}),
    })
    .prefault({}),
  deploy: z
    .object({
      environments: z.array(environment).default([]),
      watchMinutes: z
        .number()
        .int()
        .min(1)
        .max(10_080)
        .default(720)
        .describe('How long a started deploy is followed for its outcome'),
    })
    .prefault({}),
  gates: z
    .object({
      pipeline: z
        .enum(['success', 'not-failed', 'off'])
        .default('not-failed')
        .describe('Latest pipeline of the branch a step works on'),
      freeze: z.array(freezeWindow).default([]),
      blockingLabels: z
        .array(z.string())
        .default([])
        .describe('Open merge requests with one of these labels block releasing'),
    })
    .prefault({}),
  timezone: z
    .string()
    .refine(validZone, 'unknown time zone')
    .default('UTC')
    .describe('IANA time zone for dates in titles and freeze windows'),
})

/** Release settings with every default applied. */
export type ReleaseSettings = z.output<typeof releaseSettingsSchema>

/** What may be stored: any subset of the fields. */
export type ReleaseSettingsInput = z.input<typeof releaseSettingsSchema>

/** A bump of a semantic version; `none` releases nothing. */
export type Bump = z.output<typeof bump>

/** One environment a version is deployed to. */
export type ReleaseEnvironment = z.output<typeof environment>

/** Settings with defaults, from a stored value that may be missing or partial. */
export const releaseSettings = (value?: unknown): ReleaseSettings =>
  releaseSettingsSchema.parse(value ?? {})

/** Events that can be announced. */
export const releaseEventKinds = [
  'proposed',
  'merged',
  'accepted',
  'versioned',
  'deploy-started',
  'deploy-succeeded',
  'deploy-failed',
] as const

export type ReleaseEventKind = (typeof releaseEventKinds)[number]

const notifyTarget = z.object({
  kind: z.enum(['slack', 'webhook']),
  url: z.url(),
  events: z
    .array(z.enum(releaseEventKinds))
    .optional()
    .describe('Events sent to this target; all when empty'),
})

/** Where release events go; a secret setting because webhook URLs are credentials. */
export const releaseNotifySchema = z.object({ targets: z.array(notifyTarget).default([]) })

export type ReleaseNotifySettings = z.output<typeof releaseNotifySchema>

type Preset = { id: string; label: string; description: string; value: ReleaseSettingsInput }

/** Ready-made flows; each sets only the fields it is about, so presets combine. */
export const releasePresets: Preset[] = [
  {
    id: 'merge-request-deferred-version',
    label: 'Merge request, version after acceptance',
    description:
      'A release candidate merge request brings the source branch into the target; the version is created later, once someone accepts the merged changes (button or label).',
    value: {
      flow: { mode: 'merge-request' },
      acceptance: { required: true, signals: ['manual', 'label'], autoVersion: false },
    },
  },
  {
    id: 'merge-request-version-on-merge',
    label: 'Merge request, version on merge',
    description: 'Merging the release candidate creates the version right away.',
    value: {
      flow: { mode: 'merge-request' },
      acceptance: { required: true, signals: ['merge'], autoVersion: true },
    },
  },
  {
    id: 'trunk',
    label: 'Trunk-based',
    description: 'Work lands on the target branch; versions are tagged on it when needed.',
    value: { flow: { mode: 'trunk' } },
  },
  {
    id: 'calver',
    label: 'Calendar versions',
    description: 'Versions such as 2026.11.0, tags without a prefix.',
    value: { version: { scheme: 'calver', tagFormat: '{version}' } },
  },
  {
    id: 'external',
    label: 'Released by another tool',
    description:
      'Changesets, release-please or similar release the repository; Holtkeeper only shows it.',
    value: { flow: { mode: 'external' } },
  },
  {
    id: 'preprod-prod',
    label: 'Deploy to preprod, then prod',
    description: 'Manual pipeline jobs named preprod and prod; prod only after preprod succeeded.',
    value: {
      deploy: {
        environments: [
          { name: 'preprod', confirm: true },
          { name: 'prod', after: 'preprod', confirm: true },
        ],
      },
    },
  },
  {
    id: 'agent-summary',
    label: 'AI summary for QA',
    description: 'The AI agent writes what changed and what to test.',
    value: { summary: { mode: 'agent', audience: 'qa' } },
  },
  {
    id: 'changelog-file',
    label: 'Keep CHANGELOG.md',
    description: 'Each version prepends its notes to CHANGELOG.md on the target branch.',
    value: { tag: { changelogFile: { enabled: true } } },
  },
]

const help = `How a repository releases, from a release candidate to deployed versions.

- **Flow**: \`merge-request\` (a candidate merge request from \`source\` to \`target\`), \`trunk\` (versions straight from \`target\`) or \`external\` (another tool releases; the board only shows it).
- **Version**: semantic or calendar versions; the next semantic version is suggested from conventional commit types, breaking changes and merge request labels. People can always pick another.
- **Changelog**: unique commit messages since the previous version, grouped and filtered by the rules here; entries can be hidden or reworded before releasing.
- **Acceptance**: what says the merged changes may become a version — a person in Holtkeeper or its API, a label on the merged merge request, or the merge itself. Tie it to any process (QA, sign-off, a ticket workflow) through the label or the API.
- **Deploy**: manual jobs of the tag pipeline per environment, in order, followed until they finish or fail.

Set a flow for **All repositories** and override it per group or repository; presets combine.`

/** The `releases` setting for the settings registry. */
export const releaseSettingsDefinition = {
  key: releaseSettingsKey,
  label: 'Release flow',
  description: 'How releases are proposed, versioned, described and deployed.',
  section: 'Releases',
  schema: releaseSettingsSchema,
  help,
  presets: releasePresets,
}

/** The `releases.notify` setting for the settings registry. */
export const releaseNotifyDefinition = {
  key: releaseNotifySettingKey,
  label: 'Release notifications',
  description: 'Slack or webhook targets for release events; sealed because URLs are credentials.',
  section: 'Releases',
  schema: releaseNotifySchema,
  secret: true,
  help: 'Each target gets the events it lists (all when none): a candidate proposed, merged, accepted, a version created, deploys started, succeeded or failed.',
}
