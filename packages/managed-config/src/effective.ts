import { type HoltkeeperConfig, type ScheduleConfig, parseConfig } from '@holtkeeper/core'
import type { ForgeDefinition, GitForge } from '@holtkeeper/forge'
import type { AnyConfigDocument, ConfigDocument, ConfigDocumentType } from '@holtkeeper/store'

import { triggerId } from './documents.ts'

/** Where an entry of the effective config comes from. */
export type Provenance = 'file' | 'panel' | 'file+panel'

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

/** What a panel forge needs for export: kind, URL and which credential holds its token. */
export interface ForgeOrigin {
  kind: string
  url: string
  credentialId?: string
}

/**
 * The config the server runs on: the file config with panel documents applied, validated with
 * the file config's rules. `provenance` has one entry per forge, group, repo pattern, schedule
 * and trigger, keyed `<type>:<id>` (`forge:work`, `repoTraits:games/*`, `trigger:label:port`).
 */
export interface EffectiveConfig {
  config: HoltkeeperConfig
  provenance: Record<string, Provenance>
  forges: Record<string, ForgeOrigin>
}

/** The provenance key of an entry. Triggers use their document ids, repo traits their pattern. */
export const provenanceKey = (type: ConfigDocumentType, id: string) => `${type}:${id}`

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

/** The file config's schedule entry a schedule document stands for. */
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

type Jobs = NonNullable<HoltkeeperConfig['jobs']>

/** Provenance keys of the triggers a jobs section defines. */
function triggerKeys(jobs: Jobs | undefined): string[] {
  if (!jobs) return []
  return [
    ...(jobs.onTag ? ['tag'] : []),
    ...(jobs.onPush ? ['push'] : []),
    ...(jobs.onMergeRequest ? ['merge-request'] : []),
    ...Object.keys(jobs.onLabel ?? {}).map((label) => `label:${label}`),
    ...Object.keys(jobs.commands ?? {}).map((name) => `command:${name}`),
  ].map((id) => provenanceKey('trigger', id))
}

/**
 * Applies panel documents to the file config: a document replaces the file entry with the same
 * id (forges, groups, schedules by name, repo traits by pattern, triggers by trigger id) or adds
 * a new one. Panel schedules, triggers and webhook secrets create a `jobs` section with defaults
 * when the file has none. Throws `ConfigError` when the result breaks the file config's rules.
 */
export function effectiveConfig(
  file: HoltkeeperConfig,
  documents: readonly AnyConfigDocument[],
  options: EffectiveConfigOptions,
): EffectiveConfig {
  const provenance: Record<string, Provenance> = {}
  const mark = (key: string, fromFile: boolean) => {
    provenance[key] = fromFile ? 'file+panel' : 'panel'
  }
  for (const id of Object.keys(file.forges)) provenance[provenanceKey('forge', id)] = 'file'
  for (const id of Object.keys(file.groups)) provenance[provenanceKey('group', id)] = 'file'
  for (const pattern of Object.keys(file.repos))
    provenance[provenanceKey('repoTraits', pattern)] = 'file'
  for (const schedule of file.jobs?.schedules ?? [])
    provenance[provenanceKey('schedule', schedule.name)] = 'file'
  for (const key of triggerKeys(file.jobs)) provenance[key] = 'file'

  const forges: Record<string, ForgeDefinition> = { ...file.forges }
  const origins: Record<string, ForgeOrigin> = Object.fromEntries(
    Object.entries(file.forges).map(([id, forge]) => [id, { kind: forge.kind, url: forge.url }]),
  )
  const groups = { ...file.groups }
  const repos = { ...file.repos }
  const schedules = [...(file.jobs?.schedules ?? [])]
  const jobs: Partial<Jobs> = { ...file.jobs }
  let touchesJobs = false

  for (const doc of documents) {
    switch (doc.type) {
      case 'forge': {
        mark(provenanceKey('forge', doc.id), doc.id in file.forges)
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
        const secret = options.webhookSecrets?.[doc.id]
        if (secret !== undefined) {
          jobs.webhooks = { ...jobs.webhooks, [doc.id]: { secret } }
          touchesJobs = true
        }
        break
      }
      case 'group':
        mark(provenanceKey('group', doc.id), doc.id in file.groups)
        groups[doc.id] = {
          forge: doc.data.forge,
          include: doc.data.include,
          exclude: doc.data.exclude,
        }
        break
      case 'repoTraits':
        mark(provenanceKey('repoTraits', doc.data.pattern), doc.data.pattern in file.repos)
        repos[doc.data.pattern] = without({ forge: doc.data.forge, traits: doc.data.traits })
        break
      case 'schedule': {
        const schedule = scheduleFromDocument(doc)
        const index = schedules.findIndex((s) => s.name === schedule.name)
        mark(
          provenanceKey('schedule', doc.id),
          (file.jobs?.schedules ?? []).some((s) => s.name === doc.id),
        )
        if (index >= 0) schedules[index] = schedule
        else schedules.push(schedule)
        touchesJobs = true
        break
      }
      case 'trigger': {
        const id = triggerId(doc.data)
        mark(
          provenanceKey('trigger', id),
          triggerKeys(file.jobs).includes(provenanceKey('trigger', id)),
        )
        touchesJobs = true
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

  const config = parseConfig({
    ...file,
    forges,
    groups,
    repos,
    ...(file.jobs || touchesJobs ? { jobs: { ...jobs, schedules } } : {}),
  })
  return { config, provenance, forges: origins }
}
