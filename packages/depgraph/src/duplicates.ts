import { bfs, indexGraph, pathTo, rootIds } from './graph.ts'
import type { DepGraph } from './model.ts'
import { compareVersions } from './version.ts'

/** One version of a library that is present in several versions. */
export interface DuplicateVersion {
  version: string
  /** Node id of this version. */
  id: string
  /** Copied from the node: whether the ecosystem's resolver selected this version. */
  selected?: boolean
  /** Ids of the nodes that depend on this version directly, sorted. */
  dependents: string[]
  /** One shortest path from a workspace (or a root) to this version; `[]` when unreachable. */
  path: string[]
}

/** A library (same ecosystem and name) that the graph contains in more than one version. */
export interface Duplicate {
  ecosystem: string
  name: string
  /** Sorted from the lowest version to the highest. */
  versions: DuplicateVersion[]
}

/**
 * Finds libraries present in several versions. Workspaces and source modules are not libraries
 * and are never reported. Sorted by the number of versions (most first), then by name.
 */
export function findDuplicates(graph: DepGraph): Duplicate[] {
  const groups = new Map<string, { ecosystem: string; name: string; ids: Map<string, string> }>()
  for (const node of graph.nodes) {
    if (node.kind !== 'package' || node.version === undefined) continue
    const key = `${node.ecosystem}\0${node.name}`
    const group = groups.get(key) ?? { ecosystem: node.ecosystem, name: node.name, ids: new Map() }
    if (!group.ids.has(node.version)) group.ids.set(node.version, node.id)
    groups.set(key, group)
  }

  const duplicated = [...groups.values()].filter((group) => group.ids.size > 1)
  if (duplicated.length === 0) return []

  const index = indexGraph(graph)
  const { parent } = bfs(index, rootIds(index))
  return duplicated
    .map((group) => ({
      ecosystem: group.ecosystem,
      name: group.name,
      versions: [...group.ids]
        .toSorted(([a], [b]) => compareVersions(a, b))
        .map(([version, id]) => {
          const entry: DuplicateVersion = {
            version,
            id,
            dependents: [...new Set(index.in.get(id))].toSorted(),
            path: pathTo(parent, id),
          }
          const selected = index.nodes.get(id)?.selected
          if (selected !== undefined) entry.selected = selected
          return entry
        }),
    }))
    .toSorted((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name))
}
