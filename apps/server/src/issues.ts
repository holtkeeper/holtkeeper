import { scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import type { RepoRef } from '@holtkeeper/forge'
import { type IssueTracker, cachedTracker } from '@holtkeeper/issues'
import { JIRA_CREDENTIAL_KIND, jiraFromCredential } from '@holtkeeper/issues-jira'

import { type ServerDeps, repoTarget } from './context.ts'

/**
 * The issue tracker of a repository: the most specific `jira` credential whose scope covers it,
 * behind the store's key-value cache when there is one. `undefined` without such a credential or
 * when it cannot be opened, so release pages and tools fall back to plain ticket keys.
 */
export const issueTrackerFor =
  ({ config, store, credentials }: Pick<ServerDeps, 'config' | 'store' | 'credentials'>) =>
  async (repo: RepoRef): Promise<IssueTracker | undefined> => {
    const target = repoTarget(config, repo)
    const credential = (await store.credentials.list())
      .filter((item) => item.kind === JIRA_CREDENTIAL_KIND && scopeCoversRepo(item.scope, target))
      .toSorted((a, b) => scopeSpecificity(b.scope) - scopeSpecificity(a.scope))[0]
    if (!credential) return undefined
    try {
      const tracker = jiraFromCredential(credential, await credentials.reveal(credential.id))
      return store.kv
        ? cachedTracker(tracker, store.kv, {
            namespace: `${credential.id}:${credential.updatedAt}`,
          })
        : tracker
    } catch (error) {
      console.error(
        `issues: jira credential "${credential.name}" unusable: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
