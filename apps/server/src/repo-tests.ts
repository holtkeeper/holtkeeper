import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { repoTests, resolveRepoTests } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'

import { repoTarget } from './context.ts'

/** Analyzers that only make sense for repositories with tests. */
export const TEST_ANALYZERS: ReadonlySet<string> = new Set(['coverage'])

/** How `repo.tests` applies to a repository: whether tests are expected and, if not, why. */
export type RepoTestsFor = (repo: RepoRef) => Promise<{ expected: boolean; reason?: string }>

/**
 * Reads `repo.tests` for a repository with its groups from `config()`. The settings are read on
 * every call, so a change in the panel applies to the next decision.
 */
export function repoTestsFor(
  store: Pick<Store, 'settings'>,
  config: () => HoltkeeperConfig,
): RepoTestsFor {
  return async (repo) => {
    const { expected, reason } = resolveRepoTests(
      await store.settings.list(repoTests.key),
      repoTarget(config(), repo),
    )
    return reason === undefined ? { expected } : { expected, reason }
  }
}

/** Whether a repository is meant to have tests; see `repoTestsFor`. */
export function testsExpectedFor(
  store: Pick<Store, 'settings'>,
  config: () => HoltkeeperConfig,
): (repo: RepoRef) => Promise<boolean> {
  const read = repoTestsFor(store, config)
  return async (repo) => (await read(repo)).expected
}
