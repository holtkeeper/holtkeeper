import { GraphBuilder } from '@holtkeeper/depgraph'

import { isObject, objectOf, objectsOf, stringOf } from '../json.ts'
import { declaredDependencies } from '../workspaces.ts'
import { importerNode, packageNode, splitIdent, workspacesByPath } from './shared.ts'
import type { LockfileParser } from './shared.ts'

/** `@scope/a/b` → `['@scope/a', 'b']`: package keys are install paths of package names. */
function splitKey(key: string): string[] {
  const names: string[] = []
  let scope: string | undefined
  for (const part of key.split('/')) {
    if (scope !== undefined) {
      names.push(`${scope}/${part}`)
      scope = undefined
    } else if (part.startsWith('@')) scope = part
    else names.push(part)
  }
  return names
}

/**
 * Parses the text `bun.lock` (JSON with comments and trailing commas). A dependency of the package
 * at key `a/b` resolves to `a/b/<dep>`, then `a/<dep>`, then `<dep>`; workspaces look under their
 * own name first. The binary `bun.lockb` is not supported.
 */
export const parseBunLock: LockfileParser = (content, workspaces) => {
  const lock = objectOf(Bun.JSONC.parse(content))
  const packages = new Map(
    Object.entries(objectOf(lock.packages)).flatMap(([key, value]) =>
      Array.isArray(value) && typeof value[0] === 'string'
        ? [[key, { ident: value[0], info: objectOf(value.find(isObject)) }] as const]
        : [],
    ),
  )
  const byPath = workspacesByPath(workspaces)
  const builder = new GraphBuilder()
  const importers = objectsOf(lock.workspaces)
  const importerIds = new Map(
    importers.map(([path, entry]) => [
      path || '.',
      builder.node(importerNode(byPath, path, stringOf(entry.name))),
    ]),
  )

  const nodeId = (key: string): string | undefined => {
    const entry = packages.get(key)
    if (!entry) return undefined
    const { name, version } = splitIdent(entry.ident)
    if (version.startsWith('workspace:')) {
      const path = version.slice('workspace:'.length) || '.'
      return importerIds.get(path) ?? builder.node(importerNode(byPath, path, name))
    }
    return builder.node(packageNode(name, version))
  }

  const resolve = (scope: string[], name: string) => {
    for (let i = scope.length; i >= 0; i--) {
      const key = [...scope.slice(0, i), name].join('/')
      if (packages.has(key)) return nodeId(key)
    }
    return undefined
  }

  for (const [path, entry] of importers) {
    const from = importerIds.get(path || '.')
    const name = stringOf(entry.name)
    if (from === undefined) continue
    for (const dep of declaredDependencies(entry)) {
      const to = resolve(name ? [name] : [], dep.name)
      if (to !== undefined) builder.edge(from, to, dep.kind)
    }
  }

  for (const [key, { info }] of packages) {
    const from = nodeId(key)
    if (from === undefined) continue
    for (const dep of declaredDependencies(info)) {
      const to = resolve(splitKey(key), dep.name)
      if (to !== undefined && to !== from) builder.edge(from, to, dep.kind)
    }
  }
  return builder.build()
}
