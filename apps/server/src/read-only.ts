import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { repoFreeze, resolveRepoFreeze } from '@holtkeeper/settings'
import type { SettingEntry, Store } from '@holtkeeper/store'

import { repoTarget } from './context.ts'

/** Whether the `repo.freeze` entry in force for a repository forbids Holtkeeper to change it. */
export type ReadOnlyRepos = (repo: RepoRef) => Promise<boolean>

/**
 * Reads `repo.freeze` for a repository with its groups from `config()`. The settings are read on
 * every call, so a change in the panel applies to the next write, and an entry stops counting once
 * `now()` passes its `until`. The most specific entry in force wins, so a lift keeps its scope
 * writable under a broader freeze.
 */
export function readOnlyRepos(
  store: Store,
  config: () => HoltkeeperConfig,
  now: () => Date = () => new Date(),
): ReadOnlyRepos {
  return async (repo) =>
    resolveRepoFreeze(await store.settings.list(repoFreeze.key), repoTarget(config(), repo), now())
      .frozen
}

/**
 * Stored entries of the retired `repo.readOnly` setting that still say `true`. They no longer
 * protect anything: each one has to be set again as `repo.freeze`.
 */
export async function retiredReadOnlyEntries(
  store: Pick<Store, 'settings'>,
): Promise<SettingEntry[]> {
  return (await store.settings.list('repo.readOnly')).filter((entry) => entry.value === true)
}
