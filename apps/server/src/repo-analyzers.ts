import type { RepoTarget } from '@holtkeeper/access'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { analyzerOff, repoAnalyzersKey } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'

import { repoTarget } from './context.ts'

/**
 * Whether `repo.analyzers` turns `kind` off on `repo`: `{ reason? }` when it does, `undefined`
 * otherwise. Reads the settings on every call, so a change in the panel applies to the next
 * decision.
 */
export async function analyzerOffFor(
  store: Pick<Store, 'settings'>,
  config: HoltkeeperConfig,
  repo: RepoRef,
  kind: string,
): Promise<{ reason?: string } | undefined> {
  return analyzerOff(await store.settings.list(repoAnalyzersKey), repoTarget(config, repo), kind)
}

/** Whether `repo.analyzers` turns `kind` off on a repository, from one read of the settings. */
export async function analyzerOffFilter(
  store: Pick<Store, 'settings'>,
  targetOf: (repo: RepoRef) => RepoTarget,
  kind: string,
): Promise<(repo: RepoRef) => boolean> {
  const entries = await store.settings.list(repoAnalyzersKey)
  return (repo) => analyzerOff(entries, targetOf(repo), kind) !== undefined
}

/** What health, the overview and freshness say for an analyzer turned off with no reason. */
export const OFF_FALLBACK = 'turned off for this repository'

/** The text freshness and Ops show for an analyzer `repo.analyzers` turns off. */
export const offText = (off: { reason?: string }) =>
  off.reason === undefined ? OFF_FALLBACK : `turned off: ${off.reason}`
