import type { DepgraphData, LayerData } from '@holtkeeper/depgraph'
import type { PackageRef } from '@holtkeeper/vuln'

/** Ecosystems whose resolved packages the index reads from dependency graphs. */
export const INDEXED_ECOSYSTEMS: readonly string[] = ['npm', 'Go']

/** One resolved third-party package version and the file that pins it. */
export interface InventoryPackage extends PackageRef {
  /** Lockfile or manifest relative to the repository root, as an audit finding names it. */
  source: string
}

/** What a repository's dependency graph says it resolves. */
export interface Inventory {
  packages: InventoryPackage[]
  /**
   * Why the inventory must not be audited: a graph source failed (the packages it would have
   * listed are missing) or the graph has no package layer at all (no lockfile the index reads).
   * Absent when the inventory is complete.
   */
  problem?: string
}

/** Options of `inventoryOf`. */
export interface InventoryOptions {
  /** Packages the fleet defines itself, left out so a public advisory for the same name never matches. */
  isInternal?: (ecosystem: string, name: string) => boolean
}

const npmVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/u
const goVersion = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/u

const goModOf = (dir: string) => (dir === '' || dir === '.' ? 'go.mod' : `${dir}/go.mod`)

/** The file a `packages` layer's versions come from, as osv-scanner would name it. */
function sourceOf(layer: LayerData, data: DepgraphData): string {
  if (!layer.source.startsWith('go mod graph')) return layer.source
  const dir = /^go mod graph \((.+)\)$/u.exec(layer.source)?.[1]
  if (dir !== undefined) return goModOf(dir)
  const workspaces = data.layers.find(
    (each) => each.id === 'workspaces' && (each.source === 'go.work' || each.source === 'go.mod'),
  )
  if (workspaces?.source === 'go.work') return 'go.work'
  const [only] = workspaces?.graph.nodes.filter((node) => node.kind === 'workspace') ?? []
  return goModOf(only?.path ?? '.')
}

/**
 * The third-party packages of the `packages` layers of npm and Go: every resolved version with
 * the file that pins it, deduplicated. Go keeps only versions the resolver selects and drops the
 * `v` prefix (OSV's spelling); versions that are not registry versions (links, `file:`) and
 * internal packages are left out.
 */
export function inventoryOf(data: DepgraphData, options: InventoryOptions = {}): Inventory {
  const layers = data.layers.filter((layer) => layer.id === 'packages')
  const failed = data.errors[0]
  const problem = failed
    ? `${failed.source}: ${failed.message}`
    : layers.length === 0
      ? 'no lockfile the index reads'
      : undefined
  const seen = new Set<string>()
  const packages: InventoryPackage[] = []
  for (const layer of layers) {
    const source = sourceOf(layer, data)
    for (const node of layer.graph.nodes) {
      if (node.kind !== 'package' || node.version === undefined) continue
      if (!INDEXED_ECOSYSTEMS.includes(node.ecosystem)) continue
      if (node.selected === false) continue
      if (options.isInternal?.(node.ecosystem, node.name)) continue
      let version = node.version
      if (node.ecosystem === 'Go') {
        if (!goVersion.test(version)) continue
        version = version.slice(1)
      } else if (!npmVersion.test(version)) continue
      const key = `${node.ecosystem}\0${node.name}\0${version}\0${source}`
      if (seen.has(key)) continue
      seen.add(key)
      packages.push({ ecosystem: node.ecosystem, name: node.name, version, source })
    }
  }
  return { packages, ...(problem !== undefined && { problem }) }
}
