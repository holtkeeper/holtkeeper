import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { repoReadOnly, resolveSetting } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'

import { repoTarget } from './context.ts'

/** Whether the scoped `repo.readOnly` setting forbids Holtkeeper to change a repository. */
export type ReadOnlyRepos = (repo: RepoRef) => Promise<boolean>

/**
 * Reads `repo.readOnly` for a repository with its groups from `config()`. The settings are read on
 * every call, so a change in the panel applies to the next write.
 */
export function readOnlyRepos(store: Store, config: () => HoltkeeperConfig): ReadOnlyRepos {
  const key = repoReadOnly.key
  return async (repo) => {
    const entry = resolveSetting(await store.settings.list(key), key, repoTarget(config(), repo))
    return entry?.value === true
  }
}
