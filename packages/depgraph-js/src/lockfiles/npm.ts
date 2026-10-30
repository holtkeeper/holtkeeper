import { GraphBuilder } from '@holtkeeper/depgraph'

import { objectOf, objectsOf, stringOf } from '../json.ts'
import type { JsonObject } from '../json.ts'
import { declaredDependencies } from '../workspaces.ts'
import { importerNode, packageNode, workspacesByPath } from './shared.ts'
import type { LockfileParser } from './shared.ts'

const marker = 'node_modules/'

/** Where Node looks next: the enclosing package, then parent directories up to the root. */
function parentLocation(location: string): string | undefined {
  if (location === '') return undefined
  const nested = location.lastIndexOf(`/${marker}`)
  if (nested >= 0) return location.slice(0, nested)
  if (location.startsWith(marker)) return ''
  const slash = location.lastIndexOf('/')
  return slash < 0 ? '' : location.slice(0, slash)
}

/**
 * Parses `package-lock.json` (or `npm-shrinkwrap.json`) version 2 or 3. Dependencies are resolved
 * the way Node does: nested `node_modules` first, then each parent directory.
 */
export const parseNpmLock: LockfileParser = (content, workspaces) => {
  const lock = objectOf(JSON.parse(content))
  if (!lock.packages) {
    const version = typeof lock.lockfileVersion === 'number' ? lock.lockfileVersion : 1
    throw new Error(`package-lock.json v${version} is not supported; use npm 7 or later`)
  }
  const entries = new Map<string, JsonObject>(objectsOf(lock.packages))
  const byPath = workspacesByPath(workspaces)
  const builder = new GraphBuilder()

  const target = (location: string, hops = 0): string | undefined => {
    const entry = entries.get(location)
    if (!entry) return undefined
    const resolved = stringOf(entry.resolved)
    if (entry.link === true && resolved !== undefined && hops < 10)
      return target(resolved, hops + 1)
    return location
  }

  const nodeId = (location: string, entry: JsonObject): string => {
    const name = stringOf(entry.name)
    if (!location.includes(marker)) return builder.node(importerNode(byPath, location, name))
    const fallback = location.slice(location.lastIndexOf(marker) + marker.length)
    return builder.node(packageNode(name ?? fallback, stringOf(entry.version) ?? ''))
  }

  const resolve = (from: string, name: string): string | undefined => {
    for (
      let location: string | undefined = from;
      location !== undefined;
      location = parentLocation(location)
    ) {
      const candidate = `${location ? `${location}/` : ''}${marker}${name}`
      if (entries.has(candidate)) return target(candidate)
    }
    return undefined
  }

  for (const [location, entry] of entries) {
    if (entry.link === true) continue
    const from = nodeId(location, entry)
    for (const dep of declaredDependencies(entry)) {
      const resolved = resolve(location, dep.name)
      const resolvedEntry = resolved === undefined ? undefined : entries.get(resolved)
      if (resolved !== undefined && resolvedEntry)
        builder.edge(from, nodeId(resolved, resolvedEntry), dep.kind)
    }
  }
  return builder.build()
}
