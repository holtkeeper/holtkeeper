import { GraphBuilder } from '@holtkeeper/depgraph'

import { objectOf, objectsOf, stringOf, stringsOf } from '../json.ts'
import type { JsonObject } from '../json.ts'
import { declaredDependencies } from '../workspaces.ts'
import { importerNode, packageNode, splitIdent, workspacesByPath } from './shared.ts'
import type { LockfileParser } from './shared.ts'

interface ClassicEntry {
  name: string
  version: string
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

const unquote = (text: string) => {
  if (!text.startsWith('"')) return text
  const value: unknown = JSON.parse(text)
  return typeof value === 'string' ? value : text
}

/** Splits `name@range` at the `@` that is not part of a scope. */
const descriptorName = (descriptor: string) => {
  const at = descriptor.indexOf('@', 1)
  return at < 0 ? descriptor : descriptor.slice(0, at)
}

/** Parses the yarn v1 format: a YAML-like file of `descriptor, descriptor:` blocks. */
export function parseClassicEntries(content: string): Map<string, ClassicEntry> {
  const entries = new Map<string, ClassicEntry>()
  let current: ClassicEntry | undefined
  let section: 'dependencies' | 'optionalDependencies' | undefined
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const text = line.trim()
    if (indent === 0) {
      const descriptors = text.replace(/:$/, '').split(/,\s*/).map(unquote)
      current = {
        name: descriptorName(descriptors[0] ?? ''),
        version: '',
        dependencies: {},
        optionalDependencies: {},
      }
      for (const descriptor of descriptors) entries.set(descriptor, current)
      section = undefined
      continue
    }
    const match = /^("(?:[^"\\]|\\.)*"|\S+?):?(?:\s+(.*))?$/.exec(text)
    if (!current || !match?.[1]) continue
    const key = unquote(match[1])
    const value = match[2] === undefined ? undefined : unquote(match[2])
    if (indent === 2) {
      section =
        value === undefined && (key === 'dependencies' || key === 'optionalDependencies')
          ? key
          : undefined
      if (key === 'version' && value !== undefined) current.version = value
    } else if (section && value !== undefined) {
      current[section][key] = value
    }
  }
  return entries
}

/**
 * Parses `yarn.lock` from yarn 1 (classic) or yarn 2+ (berry, YAML with `__metadata`). Classic
 * lockfiles do not list workspaces, so their dependencies come from the `package.json` files;
 * berry does not separate dev dependencies, so workspace edge kinds come from them too.
 */
export const parseYarnLock: LockfileParser = (content, workspaces) =>
  content.includes('__metadata:')
    ? parseBerry(content, workspaces)
    : parseClassic(content, workspaces)

const parseClassic: LockfileParser = (content, workspaces) => {
  const entries = parseClassicEntries(content)
  const all = [workspaces.root, ...workspaces.packages]
  const byName = new Map(all.map((workspace) => [workspace.name, workspace]))
  const byPath = workspacesByPath(workspaces)
  const builder = new GraphBuilder()

  const resolve = (name: string, range: string): string | undefined => {
    const entry = entries.get(`${name}@${range}`)
    const workspace = byName.get(name)
    if (workspace && (range.startsWith('workspace:') || !entry))
      return builder.node(importerNode(byPath, workspace.path))
    return entry ? builder.node(packageNode(entry.name, entry.version)) : undefined
  }

  for (const workspace of all) {
    const from = builder.node(importerNode(byPath, workspace.path))
    for (const dep of declaredDependencies(workspace.manifest)) {
      const to = resolve(dep.name, dep.range)
      if (to !== undefined && to !== from) builder.edge(from, to, dep.kind)
    }
  }
  for (const entry of new Set(entries.values())) {
    const from = builder.node(packageNode(entry.name, entry.version))
    for (const [field, kind] of [
      ['dependencies', 'prod'],
      ['optionalDependencies', 'optional'],
    ] as const)
      for (const [name, range] of Object.entries(entry[field])) {
        const to = resolve(name, range)
        if (to !== undefined) builder.edge(from, to, kind)
      }
  }
  return builder.build()
}

const parseBerry: LockfileParser = (content, workspaces) => {
  const byPath = workspacesByPath(workspaces)
  const builder = new GraphBuilder()
  const descriptors = new Map<string, JsonObject>()
  for (const [key, entry] of objectsOf(Bun.YAML.parse(content))) {
    if (key === '__metadata') continue
    for (const descriptor of key.split(/,\s*/)) descriptors.set(descriptor, entry)
  }

  const nodeOf = (entry: JsonObject) => {
    const { name, version: reference } = splitIdent(stringOf(entry.resolution) ?? '')
    if (reference.startsWith('workspace:')) {
      const path = reference.slice('workspace:'.length)
      return { id: builder.node(importerNode(byPath, path, name)), path }
    }
    return { id: builder.node(packageNode(name, stringOf(entry.version) ?? reference)) }
  }

  for (const entry of new Set(descriptors.values())) {
    const { id: from, path } = nodeOf(entry)
    const manifest = path === undefined ? undefined : byPath.get(path || '.')?.manifest
    const kinds = new Map(
      manifest ? declaredDependencies(manifest).map((dep) => [dep.name, dep.kind]) : [],
    )
    const meta = objectOf(entry.dependenciesMeta)
    const declared = [
      ...Object.entries(stringsOf(entry.dependencies)).map(([name, range]) => ({
        name,
        range,
        peer: false,
      })),
      ...Object.entries(stringsOf(entry.peerDependencies)).map(([name, range]) => ({
        name,
        range,
        peer: true,
      })),
    ]
    for (const dep of declared) {
      const target = descriptors.get(`${dep.name}@${dep.range}`)
      if (!target) continue
      const optional = objectOf(meta[dep.name]).optional === true
      const kind = kinds.get(dep.name) ?? (dep.peer ? 'peer' : optional ? 'optional' : 'prod')
      const to = nodeOf(target).id
      if (to !== from) builder.edge(from, to, kind)
    }
  }
  return builder.build()
}
