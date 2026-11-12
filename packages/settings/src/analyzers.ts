import type { RepoTarget } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

import { repoAnalyzersKey, repoAnalyzersSchema } from './definitions.ts'
import { resolveSetting } from './resolve.ts'

/** How `repo.analyzers` applies to one repository. */
export interface ResolvedRepoAnalyzers {
  /** Analyzer kinds that are off, in the entry's order; empty when none is. */
  off: string[]
  reason?: string
  /** The entry that decided it; absent when none covers the repository and the default applies. */
  entry?: SettingEntry
}

/**
 * `repo.analyzers` for `repo`: the most specific covering entry, so a repository entry with
 * `off: []` lifts a group one. A secret or invalid winning value counts as the default (nothing
 * off), with no entry. Kinds no analyzer has are kept; they match nothing.
 */
export function resolveRepoAnalyzers(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
): ResolvedRepoAnalyzers {
  const entry = resolveSetting(entries, repoAnalyzersKey, repo)
  if (!entry || entry.secret) return { off: [] }
  const parsed = repoAnalyzersSchema.safeParse(entry.value)
  if (!parsed.success) return { off: [] }
  const { off, reason } = parsed.data
  return reason === undefined || !off.length ? { off, entry } : { off, reason, entry }
}

/**
 * Whether `repo.analyzers` turns `kind` off on `repo`: `{ reason? }` when it does, `undefined`
 * when the analyzer runs as usual.
 */
export function analyzerOff(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
  kind: string,
): { reason?: string } | undefined {
  const { off, reason } = resolveRepoAnalyzers(entries, repo)
  if (!off.includes(kind)) return undefined
  return reason === undefined ? {} : { reason }
}
