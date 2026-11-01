import type { RepoTarget } from '@holtkeeper/access'
import {
  type CommitConventions,
  type ConventionsForge,
  commitConventions,
  commitConventionsKey,
  commitConventionsSchema,
} from '@holtkeeper/commit-conventions'
import { resolveSetting } from '@holtkeeper/settings'
import type { SettingStore } from '@holtkeeper/store'

/** Commit conventions as the MCP tools read them. */
export interface McpCommitContext {
  /** The conventions of `repo` (`forge:path`), or `undefined` when the caller may not read it. */
  conventions(repo: string, commits?: number): Promise<CommitConventions | undefined>
}

/** Inputs of `commitConventionsReader`. */
export interface CommitConventionsDeps {
  /** The forge client of a configured forge id; throws when the forge is unknown. */
  forgeOf: (forge: string) => ConventionsForge
  settings: Pick<SettingStore, 'list'>
  now: () => Date
  /** How long a result is reused. Default 10 minutes. */
  ttlMs?: number
}

const maxEntries = 500

/**
 * Commit conventions per repository, reused for `ttlMs` while the `commits.conventions` setting
 * that applies stays the same. Failed reads are not kept.
 */
export function commitConventionsReader(deps: CommitConventionsDeps) {
  const ttl = deps.ttlMs ?? 10 * 60_000
  const cache = new Map<string, { at: number; value: Promise<CommitConventions> }>()

  return async (repo: RepoTarget, commits = 100): Promise<CommitConventions> => {
    const entry = resolveSetting(
      await deps.settings.list(commitConventionsKey),
      commitConventionsKey,
      repo,
    )
    const parsed = commitConventionsSchema.safeParse(entry?.value)
    const setting = parsed.success && entry ? parsed.data : undefined
    const key = `${repo.forge}:${repo.path}:${commits}:${entry?.id ?? ''}:${entry?.updatedAt ?? ''}`
    const now = deps.now().getTime()
    const hit = cache.get(key)
    if (hit && now - hit.at < ttl) return hit.value

    const value = commitConventions({
      forge: deps.forgeOf(repo.forge),
      repo: repo.path,
      label: `${repo.forge}:${repo.path}`,
      ...(setting ? { setting } : {}),
      commits,
    })
    cache.set(key, { at: now, value })
    void value.catch(() => cache.delete(key))
    for (const [old, cached] of cache)
      if (cache.size > maxEntries || now - cached.at >= ttl) cache.delete(old)
    return value
  }
}
