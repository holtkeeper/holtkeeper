import { branchApiChanges } from '@holtkeeper/api-surface'
import type { CommandRunner } from '@holtkeeper/exec'
import type { RepoRef } from '@holtkeeper/forge'
import { packageUsage } from '@holtkeeper/usages'

import type { UsageIndex } from './api-surface/usages.ts'

/**
 * The review analyzer's `apiChangesFor` hook: the public API changes of a merge request, computed
 * from its base commit and the head checkout in a temporary worktree (nothing is stored), for the
 * packages other repositories import according to the newest usage records. Packages nobody else
 * imports (apps, internal packages) are left out, so app repositories get no section.
 */
export function reviewApiChanges(deps: { usages: UsageIndex; runner: CommandRunner }) {
  return async (
    repo: RepoRef,
    context: { dir: string; baseSha: string; files: readonly string[]; signal?: AbortSignal },
  ): Promise<string | undefined> => {
    const self = `${repo.forge}:${repo.path}`
    const entries = await deps.usages.entries(() => true)
    return branchApiChanges({
      dir: context.dir,
      baseSha: context.baseSha,
      changedFiles: context.files,
      runner: deps.runner,
      ...(context.signal ? { signal: context.signal } : {}),
      consumed: (name) => packageUsage(entries, name).repos.some((usage) => usage.origin !== self),
    })
  }
}
