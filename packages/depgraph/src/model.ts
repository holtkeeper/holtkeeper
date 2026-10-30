/** What a node stands for: a project's own package, a third-party package, or a source file. */
export type DepNodeKind = 'workspace' | 'package' | 'module'

/** Why one node depends on another. `import` is a source-level import between modules. */
export type DepEdgeKind = 'prod' | 'dev' | 'peer' | 'optional' | 'import'

/**
 * One node of a dependency graph. Ids are unique within one graph only; sources choose them, e.g.
 * `debug@4.4.3` for an npm package, `packages/a/src/index.ts` for a file.
 */
export interface DepNode {
  id: string
  /** Package, module or file name; nodes with the same `ecosystem` and `name` are one library. */
  name: string
  version?: string
  /** Package ecosystem in OSV spelling, e.g. `npm`, `Go`. */
  ecosystem: string
  kind: DepNodeKind
  /** Directory or file relative to the analyzed directory, when the node lives in the repository. */
  path?: string
  /** Name of the workspace that owns the node, e.g. the package a source file belongs to. */
  workspace?: string
  /**
   * For ecosystems that build with one version per library (Go's minimal version selection):
   * whether this version is the one selected. Absent where several versions coexist (npm).
   */
  selected?: boolean
}

/** `from` depends on `to`. Both are node ids of the same graph. */
export interface DepEdge {
  from: string
  to: string
  kind: DepEdgeKind
}

/** A directed graph. Every edge refers to nodes present in `nodes`; there are no duplicate edges. */
export interface DepGraph {
  nodes: DepNode[]
  edges: DepEdge[]
}

/**
 * Which view of a repository a layer describes: dependencies between the repository's own
 * packages, the full resolved package graph (lockfile), or imports between source files.
 */
export type LayerId = 'workspaces' | 'packages' | 'modules'

/** One graph produced by a source. */
export interface GraphLayer {
  id: LayerId
  /** What the graph was read from, e.g. `package.json`, `pnpm-lock.yaml`, `go mod graph`. */
  source: string
  graph: DepGraph
}

/**
 * Reads dependency graphs of one ecosystem or tool. Sources are independent: an analysis runs
 * every source whose `detect` returns true and keeps all their layers.
 */
export interface GraphSource {
  name: string
  /** Whether the directory contains something this source understands. Must not throw. */
  detect(dir: string): Promise<boolean>
  /** Reads the graphs. May throw when the input is malformed or a tool fails. */
  load(dir: string): Promise<GraphLayer[]>
}
