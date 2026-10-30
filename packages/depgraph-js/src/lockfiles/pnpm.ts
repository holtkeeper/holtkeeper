import { posix } from 'node:path'

import { GraphBuilder } from '@holtkeeper/depgraph'
import type { DepEdgeKind } from '@holtkeeper/depgraph'

import { objectOf, objectsOf, stringOf } from '../json.ts'
import type { JsonObject } from '../json.ts'
import { importerNode, packageNode, workspacesByPath } from './shared.ts'
import type { LockfileParser } from './shared.ts'

const fields: [string, DepEdgeKind][] = [
  ['dependencies', 'prod'],
  ['optionalDependencies', 'optional'],
  ['devDependencies', 'dev'],
]

/** `debug@4.4.3(supports-color@8.1.1)` → name and version without the peer suffix. */
function splitKey(key: string) {
  const core = key.replace(/^\//, '').replace(/\(.*$/, '')
  const at = core.indexOf('@', 1)
  return { name: core.slice(0, at), version: core.slice(at + 1) }
}

/** A dependency reference: a version, `link:<path>`, or an alias `real-name@version`. */
function resolveRef(name: string, ref: string) {
  const core = ref.replace(/\(.*$/, '')
  if (core.indexOf('@', 1) > 0) return splitKey(ref)
  return { name, version: core }
}

/** Dependencies of an importer or snapshot: importers wrap refs as `{ specifier, version }`. */
function refs(entry: JsonObject, field: string): [string, string][] {
  return Object.entries(objectOf(entry[field])).flatMap(([name, value]) => {
    const ref = stringOf(value) ?? stringOf(objectOf(value).version)
    return ref ? [[name, ref]] : []
  })
}

/**
 * Parses `pnpm-lock.yaml` version 9 (`importers` and `snapshots`); version 6–8 files without
 * `snapshots` are read from `packages`. Peer-dependency variants of one version share a node.
 */
export const parsePnpmLock: LockfileParser = (content, workspaces) => {
  const lock = objectOf(Bun.YAML.parse(content))
  const byPath = workspacesByPath(workspaces)
  const builder = new GraphBuilder()
  const importers =
    lock.importers === undefined ? [['.', lock] as [string, JsonObject]] : objectsOf(lock.importers)
  const snapshots = Object.entries(objectOf(lock.snapshots ?? lock.packages))

  for (const [path, importer] of importers) {
    const from = builder.node(importerNode(byPath, path))
    for (const [field, kind] of fields) {
      for (const [name, ref] of refs(importer, field)) {
        if (ref.startsWith('link:')) {
          const target = posix.normalize(posix.join(path, ref.slice('link:'.length)))
          builder.edge(from, builder.node(importerNode(byPath, target)), kind)
          continue
        }
        const resolved = resolveRef(name, ref)
        builder.edge(from, builder.node(packageNode(resolved.name, resolved.version)), kind)
      }
    }
  }

  for (const [key, value] of snapshots) {
    const { name, version } = splitKey(key)
    const from = builder.node(packageNode(name, version))
    const snapshot = objectOf(value)
    for (const [field, kind] of fields.slice(0, 2)) {
      for (const [depName, ref] of refs(snapshot, field)) {
        if (ref.startsWith('link:')) continue
        const resolved = resolveRef(depName, ref)
        builder.edge(from, builder.node(packageNode(resolved.name, resolved.version)), kind)
      }
    }
  }
  return builder.build()
}
