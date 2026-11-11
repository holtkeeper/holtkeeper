import { z } from 'zod'

/** Setting key of the release flow of a repository. */
export const releaseSettingsKey = 'releases'

/** Setting key of where release events are announced. */
export const releaseNotifySettingKey = 'releases.notify'

const bump = z.enum(['major', 'minor', 'patch', 'none'])

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
})

/**
 * How one repository releases: where changes come from, how versions are named, what accepts a
 * candidate, which gates apply and where versions are deployed. Every field has a default, so
 * `{}` is a valid value (off, merge request flow, semver, `v{version}` tags). Everything else
 * (bump rules, changelog layout, templates) is fixed; see the package docs.
 */
export const releaseSettingsSchema = z.object({
  enabled: z.boolean().default(false).describe('Show and refresh the repository under Releases'),
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
      scheme: z
        .enum(['semver', 'calver'])
        .default('semver')
        .describe('Semantic versions, or calendar versions YYYY.MM.N'),
      tagFormat: z
        .string()
        .includes('{version}', { message: 'must contain {version}' })
        .default('v{version}')
        .describe('Tag name around the version, e.g. v{version} or release-{version}'),
      prerelease: z
        .boolean()
        .default(false)
        .describe('Release candidates first: versions become 1.2.0-rc.1, rc.2, ...'),
    })
    .prefault({}),
  acceptance: z
    .enum(['none', 'manual', 'label', 'merge'])
    .default('none')
    .describe(
      'What lets the target branch become a version: nothing, a person (panel or API), the `release-accepted` label on the merged candidate, or merging the candidate. A person can always accept.',
    ),
  changelogFile: z
    .boolean()
    .default(false)
    .describe('Prepend the notes of each version to CHANGELOG.md on the target branch'),
  changelog: z
    .object({
      excludeTypes: z.array(z.string()).default([]).describe('Commit types left out, e.g. ci'),
      ticketUrl: z
        .string()
        .optional()
        .describe('Tracker URL with {id}, e.g. https://tracker.example.com/browse/{id}'),
    })
    .prefault({}),
  mergeRequest: z
    .object({ labels: z.array(z.string()).default([]).describe('Labels of the candidate') })
    .prefault({}),
  deploy: z.object({ environments: z.array(environment).default([]) }).prefault({}),
  gates: z
    .object({
      pipeline: z
        .boolean()
        .default(true)
        .describe('A failed or canceled pipeline of the branch blocks the step'),
      blockingLabels: z
        .array(z.string())
        .default([])
        .describe('Open merge requests with one of these labels block releasing'),
    })
    .prefault({}),
})

/** Release settings with every default applied. */
export type ReleaseSettings = z.output<typeof releaseSettingsSchema>

/** What may be stored: any subset of the fields. */
export type ReleaseSettingsInput = z.input<typeof releaseSettingsSchema>

/** A bump of a semantic version; `none` releases nothing. */
export type Bump = z.output<typeof bump>

/** One environment a version is deployed to. */
export type ReleaseEnvironment = z.output<typeof environment>

/** Label on a merged candidate that accepts it when `acceptance` is `label`. */
export const acceptanceLabel = 'release-accepted'

type Path = readonly PropertyKey[]

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null

const without = (value: unknown, path: Path): unknown => {
  const [head, ...rest] = path
  if (head === undefined || !isRecord(value)) return value
  if (Array.isArray(value)) {
    const index = Number(head)
    if (!rest.length) return value.filter((_, at) => at !== index)
    return value.map((item, at) => (at === index ? without(item, rest) : item))
  }
  if (!rest.length) {
    const { [head]: _dropped, ...kept } = value
    return kept
  }
  return { ...value, [head]: without(value[head], rest) }
}

/**
 * Settings with defaults, from a stored value that may be missing, partial or written for an
 * older shape. Fields that no longer fit are dropped one by one (then their parents) until the
 * value parses, so a stale row never breaks the release flow; unknown fields are ignored.
 */
export const releaseSettings = (value?: unknown): ReleaseSettings => {
  let current: unknown = isRecord(value) ? value : {}
  for (let attempt = 0; attempt < 200; attempt++) {
    const parsed = releaseSettingsSchema.safeParse(current)
    if (parsed.success) return parsed.data
    let path: Path = parsed.error.issues[0]!.path
    const before = JSON.stringify(current)
    let next = without(current, path)
    while (path.length > 1 && JSON.stringify(next) === before) {
      path = path.slice(0, -1)
      next = without(current, path)
    }
    if (JSON.stringify(next) === before) break
    current = next
  }
  return releaseSettingsSchema.parse({})
}

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
  url: z.url().describe('Receives each event as a JSON notification'),
  events: z
    .array(z.enum(releaseEventKinds))
    .optional()
    .describe('Events sent to this target; all when empty'),
})

/** Where release events go; a secret setting because webhook URLs are credentials. */
export const releaseNotifySchema = z.object({ targets: z.array(notifyTarget).default([]) })

export type ReleaseNotifySettings = z.output<typeof releaseNotifySchema>

const help = `How a repository releases, from a release candidate to deployed versions. Off until turned on per repository or group.

- **Flow**: \`merge-request\` (a candidate merge request from \`source\` to \`target\`), \`trunk\` (versions straight from \`target\`) or \`external\` (another tool releases; Holtkeeper only shows it).
- **Version**: semantic or calendar versions; the next semantic version follows the commit conventions (breaking → major, feat → minor, else patch). People can always pick another.
- **Acceptance**: what says the merged changes may become a version.
- **Deploy**: manual jobs of the tag pipeline per environment, in order.

The release notes style is a Guide rule (section Releases), not a setting.`

/** The `releases` setting for the settings registry. */
export const releaseSettingsDefinition = {
  key: releaseSettingsKey,
  label: 'Release flow',
  description: 'How releases are proposed, versioned and deployed.',
  section: 'Releases',
  schema: releaseSettingsSchema,
  help,
}

/** The `releases.notify` setting for the settings registry. */
export const releaseNotifyDefinition = {
  key: releaseNotifySettingKey,
  label: 'Release notifications',
  description: 'Webhook targets for release events; sealed because URLs are credentials.',
  section: 'Releases',
  schema: releaseNotifySchema,
  secret: true,
  help: 'Each target gets the events it lists (all when none): a candidate proposed, merged, accepted, a version created, deploys started, succeeded or failed.',
}
