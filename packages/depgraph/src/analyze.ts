import { z } from 'zod'

import { findCycles } from './cycles.ts'
import type { Cycle } from './cycles.ts'
import { findDuplicates } from './duplicates.ts'
import type { Duplicate } from './duplicates.ts'
import type { DepGraph, GraphLayer, GraphSource, LayerId } from './model.ts'
import { graphStats } from './stats.ts'
import type { GraphStats } from './stats.ts'

/** A layer with its analyses precomputed, so reports never walk the graph again. */
export interface LayerData {
  id: LayerId
  source: string
  /** The complete graph, never truncated. */
  graph: DepGraph
  cycles: Cycle[]
  duplicates: Duplicate[]
  stats: GraphStats
}

/** Output of `analyzeDependencies`: plain JSON, validated on ingest by `depgraphDataSchema`. */
export interface DepgraphData {
  layers: LayerData[]
  /** Sources that were detected but failed to load; the other layers are still complete. */
  errors: { source: string; message: string }[]
}

const nodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().optional(),
  ecosystem: z.string(),
  kind: z.enum(['workspace', 'package', 'module']),
  path: z.string().optional(),
  workspace: z.string().optional(),
  selected: z.boolean().optional(),
})

const graphSchema = z.object({
  nodes: z.array(nodeSchema),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      kind: z.enum(['prod', 'dev', 'peer', 'optional', 'import']),
    }),
  ),
})

/** Validates `DepgraphData`, e.g. uploads from CI. */
export const depgraphDataSchema: z.ZodType<DepgraphData> = z.object({
  layers: z.array(
    z.object({
      id: z.enum(['workspaces', 'packages', 'modules']),
      source: z.string(),
      graph: graphSchema,
      cycles: z.array(z.object({ members: z.array(z.string()), path: z.array(z.string()) })),
      duplicates: z.array(
        z.object({
          ecosystem: z.string(),
          name: z.string(),
          versions: z.array(
            z.object({
              version: z.string(),
              id: z.string(),
              selected: z.boolean().optional(),
              dependents: z.array(z.string()),
              path: z.array(z.string()),
            }),
          ),
        }),
      ),
      stats: z.object({
        nodes: z.number(),
        edges: z.number(),
        byKind: z.partialRecord(z.enum(['workspace', 'package', 'module']), z.number()),
        byEcosystem: z.record(z.string(), z.number()),
        direct: z.number(),
        transitive: z.number(),
        mostDependedOn: z.array(z.object({ id: z.string(), dependents: z.number() })),
        deepestChain: z.array(z.string()),
      }),
    }),
  ),
  errors: z.array(z.object({ source: z.string(), message: z.string() })),
})

/** Runs the analyses on one layer. */
export function analyzeLayer(layer: GraphLayer): LayerData {
  return {
    id: layer.id,
    source: layer.source,
    graph: layer.graph,
    cycles: findCycles(layer.graph),
    duplicates: layer.id === 'packages' ? findDuplicates(layer.graph) : [],
    stats: graphStats(layer.graph),
  }
}

/**
 * Loads every layer from the sources that detect `dir` and analyzes it. A source that throws is
 * reported in `errors` instead of failing the whole analysis. Layers keep the order of `sources`.
 */
export async function analyzeDependencies(options: {
  dir: string
  sources: readonly GraphSource[]
}): Promise<DepgraphData> {
  const { dir, sources } = options
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        if (!(await source.detect(dir))) return { layers: [] }
        return { layers: await source.load(dir) }
      } catch (error) {
        return {
          layers: [],
          error: {
            source: source.name,
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }),
  )
  return {
    layers: results.flatMap((result) => result.layers.map(analyzeLayer)),
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
  }
}
