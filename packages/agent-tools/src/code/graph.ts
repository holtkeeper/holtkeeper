import type { AgentTool } from '@holtkeeper/agent'
import type { DepGraph } from '@holtkeeper/depgraph'
import { jsModuleSource } from '@holtkeeper/depgraph-js'
import { z } from 'zod'

import { type Budget, limitLines } from '../budget.ts'
import { insideDir, relativePath } from '../files.ts'
import { defineTool } from '../tool.ts'

/** Reads the import graph between a checkout's source files. */
export type ModuleGraphLoader = (dir: string) => Promise<DepGraph>

/**
 * The `@holtkeeper/depgraph-js` module layer: imports between files under each workspace's
 * `src/`, type-only imports excluded, workspace packages as nodes of their own.
 */
export const jsModuleGraph: ModuleGraphLoader = async (dir) => {
  const source = jsModuleSource()
  if (!(await source.detect(dir))) return { nodes: [], edges: [] }
  const layer = (await source.load(dir)).find((candidate) => candidate.id === 'modules')
  return layer?.graph ?? { nodes: [], edges: [] }
}

/** Adjacency of the module graph with a display label per node. */
export interface ModuleIndex {
  labels: Map<string, string>
  out: Map<string, string[]>
  in: Map<string, string[]>
}

function indexOf(graph: DepGraph): ModuleIndex {
  const labels = new Map<string, string>()
  const out = new Map<string, string[]>()
  const into = new Map<string, string[]>()
  for (const node of graph.nodes)
    labels.set(node.id, node.kind === 'module' ? node.id : `package ${node.name}`)
  for (const edge of graph.edges) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to])
    into.set(edge.to, [...(into.get(edge.to) ?? []), edge.from])
  }
  return { labels, out, in: into }
}

/**
 * Builds the module graph once per directory and reuses it for every call of the returned
 * function; a failed build is retried on the next call.
 */
export function cachedModuleGraph(load: ModuleGraphLoader): (dir: string) => Promise<ModuleIndex> {
  const cache = new Map<string, Promise<ModuleIndex>>()
  return (dir) => {
    let entry = cache.get(dir)
    if (!entry) {
      entry = load(dir).then(indexOf)
      entry.catch(() => cache.delete(dir))
      cache.set(dir, entry)
    }
    return entry
  }
}

function walk(edges: Map<string, string[]>, from: string, depth: number): Map<string, number> {
  const found = new Map<string, number>()
  let frontier = [from]
  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const next: string[] = []
    for (const id of frontier)
      for (const to of edges.get(id) ?? []) {
        if (to === from || found.has(to)) continue
        found.set(to, level)
        next.push(to)
      }
    frontier = next
  }
  return found
}

/** `code.imports` over one lazily built graph: who imports a file, or what it imports. */
export function importsTool(budget: Budget, load: ModuleGraphLoader = jsModuleGraph): AgentTool {
  const graph = cachedModuleGraph(load)
  return defineTool({
    name: 'code.imports',
    description:
      'The import graph around a file (files under workspaces\' src/, type-only imports excluded). `importers` (default): the modules that import it, the blast radius of a change, without grepping. `imports`: the modules it imports (other workspace packages show as "package <name>"). depth > 1 follows the graph further.',
    input: z.object({
      path: z.string().min(1).describe('File path relative to the repository root'),
      direction: z
        .enum(['importers', 'imports'])
        .optional()
        .describe('Who imports the file (default) or what it imports'),
      depth: z.number().int().min(1).max(3).optional().describe('1 (default) to 3'),
    }),
    async run({ path, direction = 'importers', depth = 1 }, { dir }) {
      const importers = direction === 'importers'
      const id = relativePath(dir, insideDir(dir, path))
      const index = await graph(dir)
      if (!index.labels.has(id))
        return `${id} is not in the module graph (only files under each workspace's src/ are indexed)`
      const found = walk(importers ? index.in : index.out, id, depth)
      if (found.size === 0)
        return importers ? `nothing imports ${id}` : `${id} imports no indexed modules`
      const lines = [...found]
        .toSorted(([a, la], [b, lb]) => la - lb || (a < b ? -1 : 1))
        .map(([node, level]) => `${depth > 1 ? `${level} ` : ''}${index.labels.get(node) ?? node}`)
      const header = `${found.size} ${importers ? 'dependents' : 'dependencies'} of ${id}`
      return [header, ...limitLines(lines, budget.maxResultLines - 1, 'modules')].join('\n')
    },
  })
}
