import type { GroupMatch } from '@holtkeeper/access'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import type { z } from 'zod'

/** When a plugin runs, besides manual runs which are always possible. */
export type Trigger = { type: 'schedule'; cron: string } | { type: 'command'; name: string }

export const schedule = (cron: string): Trigger => ({ type: 'schedule', cron })
export const command = (name: string): Trigger => ({ type: 'command', name })

/** Facts about a repository from the config's `repos`, such as `{ ssr: false }`. */
export type Traits = Record<string, string | number | boolean>

/** Everything a plugin run gets; one context per repository and run. */
export interface PluginContext<Options> {
  repo: RepoRef
  forge: GitForge
  options: Options
  traits: Traits
  dryRun: boolean
  signal: AbortSignal
}

type OptionsSchema = z.ZodType<object, object>

/** A plugin definition. `options` validates the config and types `run`'s `ctx.options`. */
export interface Plugin<Schema extends OptionsSchema = OptionsSchema> {
  name: string
  options: Schema
  triggers?: Trigger[]
  run(ctx: PluginContext<z.output<Schema>>): Promise<void>
}

/**
 * How a config uses a plugin: groups it runs on, base options and per-path overrides. A `groups`
 * entry can be a list of groups a repository must all belong to, e.g.
 * `groups: ['tools', ['frontend', 'storefront']]`.
 */
export interface PluginTargets<Schema extends OptionsSchema = OptionsSchema> {
  groups: GroupMatch[]
  exclude?: string[]
  options?: z.input<Schema>
  overrides?: Record<string, Partial<z.input<Schema>>>
}

export interface PluginUse<
  Schema extends OptionsSchema = OptionsSchema,
> extends PluginTargets<Schema> {
  plugin: Plugin<Schema>
}

/** Declares a plugin and returns the factory configs call, e.g. `browserslist({ groups: ['games'] })`. */
export function definePlugin<Schema extends OptionsSchema>(plugin: Plugin<Schema>) {
  return (targets: PluginTargets<Schema>): PluginUse<Schema> => ({ ...targets, plugin })
}
