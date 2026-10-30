import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { Secret } from '@holtkeeper/forge'

import type { EffectiveConfig } from './effective.ts'

const RAW = Symbol('raw')

interface Raw {
  [RAW]: string
}

const raw = (code: string): Raw => ({ [RAW]: code })
const isRaw = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && RAW in value

const quote = (text: string) =>
  `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`

const keyOf = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key))

const sortedRecord = <T>(record: Record<string, T>) =>
  Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

const without = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))

/** TypeScript source for a value: two-space indents, trailing commas, short lists on one line. */
function literal(value: unknown, indent = ''): string {
  if (isRaw(value)) return value[RAW]
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return 'undefined'
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => literal(item, inner))
    const flat = `[${items.join(', ')}]`
    if (!items.some((item) => item.includes('\n')) && flat.length + indent.length <= 90) return flat
    return `[\n${items.map((item) => `${inner}${item},`).join('\n')}\n${indent}]`
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([k, v]) => `${inner}${keyOf(k)}: ${literal(v, inner)},`).join('\n')}\n${indent}}`
}

/** The environment variable name a placeholder for `id`'s `what` uses, e.g. `HOLTKEEPER_WORK_TOKEN`. */
export const envName = (id: string, what: string) =>
  `HOLTKEEPER_${id.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_')}_${what}`

const envOf = (secret: Secret | undefined, fallback: string) =>
  raw(`env(${quote(typeof secret === 'object' && secret ? secret.env : fallback)})`)

const header = `// holtkeeper.config.ts exported from the Holtkeeper panel.
// Forges, groups, repository traits, schedules and triggers are the effective configuration
// (file and panel merged). Secrets are env() placeholders: set those variables before use.
// \`server\` and \`plugins\` hold runtime objects and are not exported; copy them from your
// current config file.
`

type Jobs = NonNullable<HoltkeeperConfig['jobs']>

function jobsOf(jobs: Jobs) {
  return without({
    concurrency: jobs.concurrency,
    cacheDir: jobs.cacheDir,
    timeoutMinutes: jobs.timeoutMinutes,
    execution: jobs.execution,
    schedules: jobs.schedules.map((schedule) =>
      without({
        name: schedule.name,
        title: schedule.title,
        enabled: schedule.enabled ? undefined : false,
        cron: schedule.cron,
        every: schedule.every,
        timezone: schedule.timezone,
        windows: schedule.windows,
        jitterMinutes: schedule.jitterMinutes,
        spread: schedule.spread,
        analyzers: schedule.analyzers,
        groups: schedule.groups,
        repos: schedule.repos,
        options: schedule.options,
      }),
    ),
    onTag: jobs.onTag,
    onMergeRequest: jobs.onMergeRequest && {
      ...jobs.onMergeRequest,
      draft: jobs.onMergeRequest.draft ? true : undefined,
    },
    onLabel: jobs.onLabel && sortedRecord(jobs.onLabel),
    commands: jobs.commands && sortedRecord(jobs.commands),
    botUsername: jobs.botUsername,
    webhookSecret: jobs.webhookSecret && envOf(jobs.webhookSecret, 'HOLTKEEPER_WEBHOOK_SECRET'),
    webhooks:
      jobs.webhooks &&
      sortedRecord(
        Object.fromEntries(
          Object.entries(jobs.webhooks).map(([id, hook]) => [
            id,
            { secret: envOf(hook.secret, envName(id, 'WEBHOOK_SECRET')) },
          ]),
        ),
      ),
  })
}

/**
 * The effective config as the source of a `holtkeeper.config.ts`. Output is deterministic for the
 * same input: records sorted by key, schedules in config order, defaults left out. Tokens and
 * webhook secrets become `env('…')` placeholders (existing `env()` references keep their names).
 * Forges without an adapter in this export (anything but GitLab) are left out with a comment.
 */
export function exportConfig(effective: EffectiveConfig): string {
  const { config } = effective
  const skipped: string[] = []
  const forges: Record<string, Raw> = {}
  for (const [id, origin] of Object.entries(sortedRecord(effective.forges))) {
    if (origin.kind !== 'gitlab') {
      skipped.push(`// forge ${quote(id)} (${origin.kind}, ${origin.url}) has no adapter to export`)
      continue
    }
    forges[id] = raw(
      `gitlab(${literal({ url: origin.url, token: raw(`env(${quote(envName(id, 'TOKEN'))})`) }, '    ')})`,
    )
  }
  const groups = Object.fromEntries(
    Object.entries(sortedRecord(config.groups)).map(([id, group]) => [
      id,
      without({
        forge: group.forge,
        include: group.include,
        exclude: group.exclude.length ? group.exclude : undefined,
      }),
    ]),
  )
  const repos = Object.fromEntries(
    Object.entries(sortedRecord(config.repos)).map(([pattern, repo]) => [
      pattern,
      without({ forge: repo.forge, traits: sortedRecord(repo.traits) }),
    ]),
  )
  const body = without({
    dryRun: config.dryRun ? true : undefined,
    forges,
    groups: Object.keys(groups).length ? groups : undefined,
    repos: Object.keys(repos).length ? repos : undefined,
    jobs: config.jobs && jobsOf(config.jobs),
  })
  const imports = [
    "import { defineConfig, env } from '@holtkeeper/core'",
    ...(Object.keys(forges).length ? ["import { gitlab } from '@holtkeeper/forge-gitlab'"] : []),
  ]
  return [
    header,
    imports.join('\n'),
    '',
    ...(skipped.length ? [...skipped, ''] : []),
    `export default defineConfig(${literal(body)})`,
    '',
  ].join('\n')
}
