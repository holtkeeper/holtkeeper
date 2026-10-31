import type { GitForge, RepoRef } from '@holtkeeper/forge'

/** What an applicability check may read: the repository's default branch through its forge. */
export interface ApplicabilityContext {
  repo: RepoRef
  forge: Pick<GitForge, 'readFile'>
  signal?: AbortSignal
}

/**
 * Whether a repository has anything for an analyzer, answered through the forge API without a
 * checkout. Checks should read few, small files: runners call them for every repository of a
 * schedule on every run.
 */
export type Applicability = (context: ApplicabilityContext) => Promise<boolean>

/** Root lockfiles of the JavaScript package managers, in the order they are looked for. */
export const jsLockfiles = ['bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']

/** Applies when any of `paths` exists. */
export const hasFile =
  (...paths: string[]): Applicability =>
  async ({ repo, forge }) => {
    for (const path of paths) {
      // oxlint-disable-next-line no-await-in-loop -- stops at the first file found
      if ((await forge.readFile(repo.path, path)) !== undefined) return true
    }
    return false
  }

/** Applies when any of `paths` exists and its text contains `needle` or matches it. */
export const fileContains =
  (paths: string[], needle: string | RegExp): Applicability =>
  async ({ repo, forge }) => {
    for (const path of paths) {
      // oxlint-disable-next-line no-await-in-loop -- stops at the first match
      const text = await forge.readFile(repo.path, path)
      if (text === undefined) continue
      if (typeof needle === 'string' ? text.includes(needle) : needle.test(text)) return true
    }
    return false
  }

/** Applies when a root JavaScript lockfile resolves the npm package `name`, directly or transitively. */
export const lockfileHasPackage = (name: string): Applicability =>
  fileContains(
    jsLockfiles,
    new RegExp(`(^|["'/\\s])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(@|"\\s*:)`, 'm'),
  )

/** Applies when any check applies; checks run in order and stop at the first that does. */
export const anyOf =
  (...checks: Applicability[]): Applicability =>
  async (context) => {
    for (const check of checks) {
      // oxlint-disable-next-line no-await-in-loop -- later checks are skipped once one applies
      if (await check(context)) return true
    }
    return false
  }

/** Applies when every check applies; checks run in order and stop at the first that does not. */
export const allOf =
  (...checks: Applicability[]): Applicability =>
  async (context) => {
    for (const check of checks) {
      // oxlint-disable-next-line no-await-in-loop -- later checks are skipped once one fails
      if (!(await check(context))) return false
    }
    return true
  }
