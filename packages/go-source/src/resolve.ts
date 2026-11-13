import { posix } from 'node:path'

import type { GoWorkspaceModule } from './gomod.ts'

/** Whether an import path belongs to the standard library: its first element has no dot. */
export const isStdlibImport = (importPath: string) =>
  !(importPath.split('/')[0] ?? '').includes('.')

const within = (importPath: string, module: string) =>
  importPath === module || importPath.startsWith(`${module}/`)

const subpathOf = (importPath: string, module: string) =>
  importPath === module ? '.' : `./${importPath.slice(module.length + 1)}`

/** Where an import path of a Go file leads. */
export type GoImportResolution =
  | { kind: 'stdlib' }
  | {
      /** A module of the repository itself: own, nested, `go.work` member or locally replaced. */
      kind: 'local'
      module: string
      /** `.` for the module's root package, else `./sub/pkg`. */
      subpath: string
      /** Directory of that module relative to the repository, when it is known there. */
      dir?: string
      /**
       * Reached only through a directory `replace` of the owning `go.mod`, not as a module the
       * repository's discovery found: a fork or a sibling checkout, not a module it defines.
       */
      replaced?: true
    }
  | {
      kind: 'external'
      module: string
      subpath: string
      /**
       * Version of this module path the owning module builds with: a same-path `replace` target's
       * version, else `require`. Never the version of another module that replaces it.
       */
      version?: string
      /** Version from `require`, when it differs from `version` or there is no `version`. */
      required?: string
      /** Module that replaces it, when `replace` points at another module path. */
      replacedBy?: string
      /** Version of `replacedBy`. */
      replacedVersion?: string
      indirect?: true
    }
  /** Not stdlib and no module of the repository or of the owning `go.mod` covers it. */
  | { kind: 'unresolved' }

const longest = <T>(candidates: T[], path: (item: T) => string) =>
  candidates.reduce<T | undefined>(
    (best, item) => (!best || path(item).length > path(best).length ? item : best),
    undefined,
  )

/**
 * Resolves an import path seen in a file of `owning` to the module that provides it: the longest
 * module path that is a prefix at a `/` boundary, first among the repository's `modules` (own,
 * nested and `go.work` modules are local), then among the owning `go.mod`'s `require` and
 * `replace` paths. A `replace` with a directory target makes the module local (`replaced`); one
 * with the same module path gives its version; one with another module path keeps the `require`
 * version and names the replacement in `replacedBy`/`replacedVersion`. Paths whose first element has no dot and that no module
 * covers are stdlib. Reads only the given `go.mod` data: no network, no `go` command.
 */
export function resolveGoImport(
  importPath: string,
  owning: GoWorkspaceModule,
  modules: readonly GoWorkspaceModule[],
): GoImportResolution {
  const local = longest(
    [owning, ...modules].filter((module) => within(importPath, module.module)),
    (module) => module.module,
  )
  const replaces = owning.mod.replace.filter((replace) => within(importPath, replace.path))
  const requires = owning.mod.require.filter((require) => within(importPath, require.path))
  const path = longest([...replaces.map((r) => r.path), ...requires.map((r) => r.path)], (p) => p)

  if (local && (!path || local.module.length >= path.length))
    return {
      kind: 'local',
      module: local.module,
      subpath: subpathOf(importPath, local.module),
      dir: local.dir,
    }
  if (!path) return isStdlibImport(importPath) ? { kind: 'stdlib' } : { kind: 'unresolved' }

  const require = requires.find((item) => item.path === path)
  const replace =
    replaces.find((item) => item.path === path && item.version === require?.version) ??
    replaces.find((item) => item.path === path && item.version === undefined)
  const subpath = subpathOf(importPath, path)
  if (replace?.local) {
    const dir = posix.isAbsolute(replace.to) ? undefined : posix.join(owning.dir, replace.to)
    return {
      kind: 'local',
      module: path,
      subpath,
      ...(dir !== undefined && !dir.startsWith('..') ? { dir } : {}),
      replaced: true,
    }
  }
  const fork = replace && replace.to !== path ? replace : undefined
  const version = replace && !fork ? replace.toVersion : require?.version
  return {
    kind: 'external',
    module: path,
    subpath,
    ...(version ? { version } : {}),
    ...(require && require.version !== version ? { required: require.version } : {}),
    ...(fork ? { replacedBy: fork.to } : {}),
    ...(fork?.toVersion ? { replacedVersion: fork.toVersion } : {}),
    ...(require?.indirect ? { indirect: true as const } : {}),
  }
}
