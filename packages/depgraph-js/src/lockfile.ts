import { join } from 'node:path'

import type { GraphSource } from '@holtkeeper/depgraph'

import { stringOf } from './json.ts'
import { parseBunLock } from './lockfiles/bun.ts'
import { parseNpmLock } from './lockfiles/npm.ts'
import { parsePnpmLock } from './lockfiles/pnpm.ts'
import type { LockfileParser } from './lockfiles/shared.ts'
import { parseYarnLock } from './lockfiles/yarn.ts'
import { readJsWorkspaces, readJsonObject } from './workspaces.ts'

/** A lockfile format this package reads. */
export interface Lockfile {
  file: string
  /** Package manager name as written in the `packageManager` field of `package.json`. */
  manager: 'pnpm' | 'bun' | 'npm' | 'yarn'
  parse: LockfileParser
}

/** Supported lockfiles in the order they are preferred when several are present. */
export const lockfiles: readonly Lockfile[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm', parse: parsePnpmLock },
  { file: 'bun.lock', manager: 'bun', parse: parseBunLock },
  { file: 'package-lock.json', manager: 'npm', parse: parseNpmLock },
  { file: 'npm-shrinkwrap.json', manager: 'npm', parse: parseNpmLock },
  { file: 'yarn.lock', manager: 'yarn', parse: parseYarnLock },
]

/**
 * The lockfile to read in `dir`: the one matching `packageManager` from `package.json` when
 * present, otherwise the first existing one in `lockfiles` order.
 */
export async function findLockfile(dir: string): Promise<Lockfile | undefined> {
  const present: Lockfile[] = []
  for (const lockfile of lockfiles)
    if (await Bun.file(join(dir, lockfile.file)).exists()) present.push(lockfile)
  if (present.length < 2) return present[0]
  const manifest = await readJsonObject(join(dir, 'package.json'))
  const manager = stringOf(manifest?.packageManager)?.split('@')[0]
  return present.find((lockfile) => lockfile.manager === manager) ?? present[0]
}

/**
 * The resolved package graph from the lockfile of `dir` (`pnpm-lock.yaml`, `bun.lock`,
 * `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`). Workspaces are nodes with the same
 * ids as in the workspace layer; packages are `name@version`.
 */
export function jsLockfileSource(): GraphSource {
  return {
    name: 'js-lockfile',
    detect: async (dir) => (await findLockfile(dir)) !== undefined,
    async load(dir) {
      const lockfile = await findLockfile(dir)
      if (!lockfile) return []
      const [content, workspaces] = await Promise.all([
        Bun.file(join(dir, lockfile.file)).text(),
        readJsWorkspaces(dir),
      ])
      return [{ id: 'packages', source: lockfile.file, graph: lockfile.parse(content, workspaces) }]
    },
  }
}
