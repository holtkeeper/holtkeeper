import { type RepoTarget, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import { confluenceFromCredential } from '@holtkeeper/confluence'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { resolveSetting } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import {
  type DocumentSink,
  type DocumentSource,
  type TrackerDefinitionInput,
  trackersSchema,
} from '@holtkeeper/tracker'
import type { Vault } from '@holtkeeper/vault'

import { repoTarget } from './context.ts'

interface DocumentDeps {
  config: HoltkeeperConfig
  store: Store
  vault: Vault
}

/** Group analyses use `{ forge, path: <group> }`; such a target belongs to that group. */
function targetOf(config: HoltkeeperConfig, repo: RepoRef): RepoTarget {
  const target = repoTarget(config, repo)
  return repo.path in config.groups
    ? { ...target, groups: [...new Set([...target.groups, repo.path])] }
    : target
}

async function confluenceFor({ config, store, vault }: DocumentDeps, repo: RepoRef) {
  const target = targetOf(config, repo)
  const credential = (await store.credentials.list())
    .filter((c) => c.kind === 'confluence' && scopeCoversRepo(c.scope, target))
    .toSorted((a, b) => scopeSpecificity(b.scope) - scopeSpecificity(a.scope))[0]
  return credential
    ? confluenceFromCredential(credential, await vault.open(credential.secret))
    : undefined
}

/**
 * Document providers for a repository or group, from `confluence` credentials whose scope covers
 * it (the most specific one wins). More providers are added here as they appear.
 */
export const documentSourcesFor =
  (deps: DocumentDeps) =>
  async (repo: RepoRef): Promise<Record<string, DocumentSource>> => {
    const confluence = await confluenceFor(deps, repo)
    return confluence ? { confluence: confluence.source } : {}
  }

export const documentSinksFor =
  (deps: DocumentDeps) =>
  async (repo: RepoRef): Promise<Record<string, DocumentSink>> => {
    const confluence = await confluenceFor(deps, repo)
    return confluence ? { confluence: confluence.sink } : {}
  }

/** Tracker definitions from the scoped `trackers` setting. */
export const trackerDefinitionsFor =
  ({ config, store }: Pick<DocumentDeps, 'config' | 'store'>) =>
  async (repo: RepoRef): Promise<TrackerDefinitionInput[]> => {
    const value = resolveSetting(
      await store.settings.list(),
      'trackers',
      targetOf(config, repo),
    )?.value
    const parsed = trackersSchema.safeParse(value)
    return parsed.success ? parsed.data : []
  }
