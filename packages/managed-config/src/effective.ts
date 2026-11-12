import {
  type HoltkeeperConfig,
  type HoltkeeperFileConfig,
  type ScheduleConfig,
  parseConfig,
} from '@holtkeeper/core'
import type { ForgeDefinition, GitForge } from '@holtkeeper/forge'
import type { AnyConfigDocument, ConfigDocument } from '@holtkeeper/store'

/** Builds the forge definition of a panel forge document from its revealed token. */
export type ForgeFactory = (doc: ConfigDocument<'forge'>, token: string) => ForgeDefinition

export interface EffectiveConfigOptions {
  /** One factory per forge kind; documents of other kinds get a forge whose `create` throws. */
  forgeFactories: Partial<Record<ConfigDocument<'forge'>['data']['kind'], ForgeFactory>>
  /** Plaintext tokens by credential id; a forge whose token is missing cannot be created. */
  tokens?: Readonly<Record<string, string>>
  /** Plaintext webhook secrets by forge id, for `jobs.webhooks`. */
  webhookSecrets?: Readonly<Record<string, string>>
  /**
   * Returns the definition to use for a forge document, e.g. a cached one for the same version
   * and token. Default: `build()`.
   */
  reuse?: (
    doc: ConfigDocument<'forge'>,
    token: string | undefined,
    build: () => ForgeDefinition,
  ) => ForgeDefinition
}

/** A forge's kind, URL and the credential that holds its token. */
export interface ForgeOrigin {
  kind: string
  url: string
  credentialId: string
}

/** The config the server runs on (file config plus panel documents) and each forge's origin. */
export interface EffectiveConfig {
  config: HoltkeeperConfig
  forges: Record<string, ForgeOrigin>
}

/** `value` without its `undefined` fields, so optional fields stay absent. */
function without<T extends Record<string, unknown>>(value: T): T {
  const copy = { ...value }
  for (const key of Object.keys(copy)) if (copy[key] === undefined) delete copy[key]
  return copy
}

/** A forge that cannot be built; tasks using it fail with `reason`. */
export const unavailableForge = (kind: string, url: string, reason: string): ForgeDefinition => ({
  kind,
  url,
  create: () => {
    throw new Error(reason)
  },
})

/** Wraps a definition so `create` builds the client once and then returns the same one. */
export function memoizeForge(definition: ForgeDefinition): ForgeDefinition {
  let client: GitForge | undefined
  return { ...definition, create: () => (client ??= definition.create()) }
}

/** The effective config's schedule entry a schedule document stands for. */
export function scheduleFromDocument(doc: ConfigDocument<'schedule'>): ScheduleConfig {
  const { data } = doc
  return without({
    name: doc.id,
    title: data.name,
    enabled: data.enabled,
    cron: data.cron,
    every: data.every,
    timezone: data.timezone,
    windows: data.windows,
    jitterMinutes: data.jitterMinutes,
    spread: data.spread,
    analyzers: data.analyzers,
    groups: data.groups,
    repos: data.repos,
    options: data.options,
  })
}

type Jobs = HoltkeeperConfig['jobs']

/**
 * Builds the effective config from the file config and the panel documents: forges, groups,
 * repository traits, schedules, triggers (by trigger id), bot usernames and webhook secrets all
 * come from documents. Throws `ConfigError` when the documents reference each other wrongly
 * (unknown forge or group, duplicate schedule).
 */
export function effectiveConfig(
  file: HoltkeeperFileConfig,
  documents: readonly AnyConfigDocument[],
  options: EffectiveConfigOptions,
): EffectiveConfig {
  const forges: Record<string, ForgeDefinition> = {}
  const origins: Record<string, ForgeOrigin> = {}
  const groups: HoltkeeperConfig['groups'] = {}
  const repos: HoltkeeperConfig['repos'] = {}
  const schedules: ScheduleConfig[] = []
  const jobs: Partial<Jobs> = { ...file.jobs }

  for (const doc of documents) {
    switch (doc.type) {
      case 'forge': {
        const token = options.tokens?.[doc.data.credentialId]
        const factory = options.forgeFactories[doc.data.kind]
        const build = () =>
          !factory
            ? unavailableForge(
                doc.data.kind,
                doc.data.url,
                `forge ${doc.id}: no ${doc.data.kind} adapter is available`,
              )
            : token === undefined
              ? unavailableForge(
                  doc.data.kind,
                  doc.data.url,
                  `forge ${doc.id}: credential ${doc.data.credentialId} is not available`,
                )
              : factory(doc, token)
        forges[doc.id] = options.reuse ? options.reuse(doc, token, build) : build()
        origins[doc.id] = {
          kind: doc.data.kind,
          url: doc.data.url,
          credentialId: doc.data.credentialId,
        }
        if (doc.data.botUsername)
          jobs.botUsernames = { ...jobs.botUsernames, [doc.id]: doc.data.botUsername }
        const secret = options.webhookSecrets?.[doc.id]
        if (secret !== undefined) jobs.webhooks = { ...jobs.webhooks, [doc.id]: { secret } }
        break
      }
      case 'group':
        groups[doc.id] = without({
          title: doc.data.title,
          forge: doc.data.forge,
          include: doc.data.include,
          exclude: doc.data.exclude,
        })
        break
      case 'repoTraits':
        repos[doc.data.pattern] = without({ forge: doc.data.forge, traits: doc.data.traits })
        break
      case 'schedule':
        schedules.push(scheduleFromDocument(doc))
        break
      case 'trigger': {
        const data = doc.data
        if (data.on === 'tag')
          jobs.onTag = without({ analyzers: data.analyzers, groups: data.groups })
        else if (data.on === 'push')
          jobs.onPush = without({
            analyzers: data.analyzers,
            branches: data.branches,
            groups: data.groups,
          })
        else if (data.on === 'mergeRequest')
          jobs.onMergeRequest = without({
            analyzers: data.analyzers,
            actions: data.actions,
            draft: data.draft ?? false,
            groups: data.groups,
          })
        else if (data.on === 'newRepo')
          jobs.onNewRepo = without({
            analyzers: data.analyzers,
            exclude: data.exclude,
            groups: data.groups,
          })
        else if (data.on === 'label')
          jobs.onLabel = { ...jobs.onLabel, [data.label]: data.analyzers }
        else
          jobs.commands = {
            ...jobs.commands,
            [data.command]: without({ analyzer: data.analyzer, args: data.args }),
          }
        break
      }
    }
  }

  const config = parseConfig({ ...file, forges, groups, repos, jobs: { ...jobs, schedules } })
  return { config, forges: origins }
}
