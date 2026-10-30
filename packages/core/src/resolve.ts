import { groupsMatch } from '@holtkeeper/access'
import type { RepoRef } from '@holtkeeper/forge'

import type { HoltkeeperConfig } from './config.ts'
import type { Plugin, PluginUse, Traits } from './plugin.ts'

export interface ResolvedPlugin {
  plugin: Plugin
  options: unknown
}

export interface ResolvedRepo {
  repo: RepoRef
  groups: string[]
  traits: Traits
  plugins: ResolvedPlugin[]
}

const matches = (pattern: string, path: string) => new Bun.Glob(pattern).match(path)
const matchesAny = (patterns: string[], path: string) => patterns.some((p) => matches(p, path))

/** A plugin's options for one repository path: base options, then matching overrides in order. */
export function resolveOptions(use: PluginUse, path: string): unknown {
  const merged = { ...use.options }
  for (const [pattern, override] of Object.entries(use.overrides ?? {})) {
    if (matches(pattern, path)) Object.assign(merged, override)
  }
  return use.plugin.options.parse(merged)
}

/** What applies to a repository: its groups, merged traits and plugins with final options. */
export function resolveRepo(config: HoltkeeperConfig, repo: RepoRef): ResolvedRepo {
  const groups = Object.entries(config.groups)
    .filter(
      ([, group]) =>
        group.forge === repo.forge &&
        matchesAny(group.include, repo.path) &&
        !matchesAny(group.exclude, repo.path),
    )
    .map(([name]) => name)

  const traits: Traits = {}
  for (const [pattern, entry] of Object.entries(config.repos)) {
    if ((!entry.forge || entry.forge === repo.forge) && matches(pattern, repo.path)) {
      Object.assign(traits, entry.traits)
    }
  }

  const plugins = config.plugins
    .filter((use) => groupsMatch(use.groups, groups) && !matchesAny(use.exclude ?? [], repo.path))
    .map((use) => ({ plugin: use.plugin, options: resolveOptions(use, repo.path) }))

  return { repo, groups, traits, plugins }
}
