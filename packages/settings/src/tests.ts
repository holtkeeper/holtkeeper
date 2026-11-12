import type { RepoTarget } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

import { repoTests, repoTestsSchema } from './definitions.ts'
import { resolveSetting } from './resolve.ts'

/** How `repo.tests` applies to one repository. */
export interface ResolvedRepoTests {
  expected: boolean
  reason?: string
  /** The entry that decided it; absent when none covers the repository and the default applies. */
  entry?: SettingEntry
}

/**
 * `repo.tests` for `repo`: the most specific covering entry, so a repository entry lifts a group
 * one. A secret or invalid winning value counts as the default (tests expected), with no entry.
 */
export function resolveRepoTests(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
): ResolvedRepoTests {
  const entry = resolveSetting(entries, repoTests.key, repo)
  if (!entry || entry.secret) return { expected: true }
  const parsed = repoTestsSchema.safeParse(entry.value)
  if (!parsed.success) return { expected: true }
  const { expected, reason } = parsed.data
  return reason === undefined ? { expected, entry } : { expected, reason, entry }
}

/** Whether `repo` is meant to have tests; `false` only when a `repo.tests` entry turns them off. */
export function testsExpected(entries: readonly SettingEntry[], repo: RepoTarget): boolean {
  return resolveRepoTests(entries, repo).expected
}
