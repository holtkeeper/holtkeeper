import type { GraphSource } from '@holtkeeper/depgraph'

import { jsLockfileSource } from './lockfile.ts'
import { jsModuleSource } from './modules.ts'
import { jsWorkspaceSource } from './workspaces.ts'

export { parseBunLock } from './lockfiles/bun.ts'
export { parseNpmLock } from './lockfiles/npm.ts'
export { parsePnpmLock } from './lockfiles/pnpm.ts'
export type { LockfileParser } from './lockfiles/shared.ts'
export { parseYarnLock } from './lockfiles/yarn.ts'
export * from './lockfile.ts'
export * from './modules.ts'
export { jsWorkspaceSource, readJsWorkspaces } from './workspaces.ts'
export type { JsWorkspace, JsWorkspaces, Manifest } from './workspaces.ts'

/** Every JavaScript source: workspaces, the lockfile package graph and source-file imports. */
export const jsSources = (): GraphSource[] => [
  jsWorkspaceSource(),
  jsLockfileSource(),
  jsModuleSource(),
]
