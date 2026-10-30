import type { DepGraph, DepNode } from '@holtkeeper/depgraph'

import { workspaceNode } from '../workspaces.ts'
import type { JsWorkspace, JsWorkspaces } from '../workspaces.ts'

/** Turns lockfile text into the package graph; workspaces give names and paths of importers. */
export type LockfileParser = (content: string, workspaces: JsWorkspaces) => DepGraph

/** The node of a resolved npm package; one node per name and version. */
export function packageNode(name: string, version: string): DepNode {
  return { id: `${name}@${version}`, name, version, ecosystem: 'npm', kind: 'package' }
}

/** `@scope/name@1.0.0` → name and version; the `@` of a scope is not a separator. */
export function splitIdent(ident: string): { name: string; version: string } {
  const at = ident.indexOf('@', 1)
  return at < 0
    ? { name: ident, version: '' }
    : { name: ident.slice(0, at), version: ident.slice(at + 1) }
}

/** Workspaces by path (`.` for the root), with lockfile importer paths normalized. */
export function workspacesByPath(workspaces: JsWorkspaces): Map<string, JsWorkspace> {
  return new Map(
    [workspaces.root, ...workspaces.packages].map((workspace) => [workspace.path, workspace]),
  )
}

/** A workspace node for an importer path, also when the path is missing from the workspace list. */
export function importerNode(
  byPath: Map<string, JsWorkspace>,
  path: string,
  name?: string,
): DepNode {
  const normalized = path === '' ? '.' : path
  const known = byPath.get(normalized)
  return workspaceNode(known ?? { name: name ?? normalized, path: normalized, manifest: {} })
}
