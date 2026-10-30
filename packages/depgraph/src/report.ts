import { defineAnalysis, metric } from '@holtkeeper/report'
import type {
  Block,
  Cell,
  GraphEdge,
  GraphNode,
  Issue,
  Metric,
  Report,
  Section,
} from '@holtkeeper/report'

import { depgraphDataSchema } from './analyze.ts'
import type { DepgraphData, LayerData } from './analyze.ts'
import type { Duplicate } from './duplicates.ts'
import type { DepNode, LayerId } from './model.ts'

/** How many rows long lists show before summarizing the rest. */
const limits = { issues: 100, duplicates: 100, moduleCycles: 50, mostUsed: 15 }

const layersOf = (data: DepgraphData, id: LayerId) => data.layers.filter((layer) => layer.id === id)

const sum = (layers: LayerData[], count: (layer: LayerData) => number) =>
  layers.reduce((total, layer) => total + count(layer), 0)

function counts(data: DepgraphData) {
  const workspaceLayers = layersOf(data, 'workspaces')
  const packageLayers = layersOf(data, 'packages')
  return {
    workspaces: sum(
      workspaceLayers.length > 0 ? workspaceLayers : packageLayers,
      (layer) => layer.stats.byKind.workspace ?? 0,
    ),
    packages: sum(packageLayers, (layer) => layer.stats.byKind.package ?? 0),
    duplicates: sum(packageLayers, (layer) => layer.duplicates.length),
    workspaceCycles: sum(workspaceLayers, (layer) => layer.cycles.length),
    moduleCycles: sum(layersOf(data, 'modules'), (layer) => layer.cycles.length),
  }
}

const problem = (value: number, tone: 'warning' | 'bad'): Partial<Metric> =>
  value > 0 ? { tone } : { tone: 'good' }

function metrics(data: DepgraphData, previous?: DepgraphData): Metric[] {
  const now = counts(data)
  const before = previous ? counts(previous) : undefined
  return [
    metric('workspaces', 'Workspaces', now.workspaces, { previous: before?.workspaces }),
    metric('packages', 'Packages', now.packages, {
      previous: before?.packages,
      hint: 'Resolved third-party packages',
    }),
    {
      ...metric('duplicates', 'Duplicated libraries', now.duplicates, {
        previous: before?.duplicates,
        better: 'down',
      }),
      ...problem(now.duplicates, 'warning'),
    },
    {
      ...metric('workspace-cycles', 'Workspace cycles', now.workspaceCycles, {
        previous: before?.workspaceCycles,
        better: 'down',
      }),
      ...problem(now.workspaceCycles, 'bad'),
    },
    {
      ...metric('module-cycles', 'Module cycles', now.moduleCycles, {
        previous: before?.moduleCycles,
        better: 'down',
      }),
      ...problem(now.moduleCycles, 'bad'),
    },
  ]
}

/** Short human name of a node: `name@version` for packages, the path for files. */
function labeler(layer: LayerData) {
  const nodes = new Map(layer.graph.nodes.map((node) => [node.id, node]))
  return (id: string) => {
    const node: DepNode | undefined = nodes.get(id)
    if (!node) return id
    if (node.kind === 'module') return node.path ?? node.name
    if (node.kind === 'package' && node.version) return `${node.name}@${node.version}`
    return node.name
  }
}

const arrow = (path: string[], label: (id: string) => string) => path.map(label).join(' → ')

function cycleIssues(layer: LayerData, title: string): Issue[] {
  const label = labeler(layer)
  const nodes = new Map(layer.graph.nodes.map((node) => [node.id, node]))
  return layer.cycles.map((cycle, i) => {
    const workspaces = [
      ...new Set(
        cycle.members.map((id) => nodes.get(id)?.workspace).filter((name) => name !== undefined),
      ),
    ]
    return {
      id: `${layer.id}-${layer.source}-cycle-${i}`,
      tone: 'bad',
      title: `${title}: ${arrow(cycle.path, label)}`,
      ...(cycle.members.length > cycle.path.length - 1
        ? { detail: `${cycle.members.length} members: ${cycle.members.map(label).join(', ')}` }
        : {}),
      tags: [layer.source, ...workspaces],
    }
  })
}

const duplicateKey = (duplicate: Duplicate) => `${duplicate.ecosystem}:${duplicate.name}`

function versionText(version: Duplicate['versions'][number]) {
  if (version.selected === true) return `${version.version} (selected)`
  if (version.selected === false) return `${version.version} (requested)`
  return version.version
}

function duplicateIssues(layer: LayerData): Issue[] {
  const label = labeler(layer)
  return layer.duplicates.map((duplicate) => ({
    id: `duplicate-${duplicateKey(duplicate)}`,
    tone: 'warning',
    title: `${duplicate.name} in ${duplicate.versions.length} versions: ${duplicate.versions.map(versionText).join(', ')}`,
    detail: duplicate.versions
      .map((version) => `${version.version}: ${arrow(version.path, label) || 'unreachable'}`)
      .join('\n'),
    tags: [duplicate.ecosystem, layer.source],
  }))
}

/** Cycles of the package layer that are not just the workspace cycles seen again. */
function packageCycles(layer: LayerData): LayerData {
  const workspaces = new Set(
    layer.graph.nodes.filter((node) => node.kind === 'workspace').map((node) => node.id),
  )
  return {
    ...layer,
    cycles: layer.cycles.filter((cycle) => cycle.members.some((id) => !workspaces.has(id))),
  }
}

function capped<T>(items: T[], limit: number, what: string): { items: T[]; more: Block[] } {
  if (items.length <= limit) return { items, more: [] }
  return {
    items: items.slice(0, limit),
    more: [{ type: 'markdown', text: `…and ${items.length - limit} more ${what}.` }],
  }
}

function issuesSection(data: DepgraphData): Section {
  const items = [
    ...layersOf(data, 'workspaces').flatMap((layer) => cycleIssues(layer, 'Workspace cycle')),
    ...layersOf(data, 'packages').flatMap((layer) =>
      cycleIssues(packageCycles(layer), 'Package cycle'),
    ),
    ...layersOf(data, 'modules').flatMap((layer) => cycleIssues(layer, 'Module cycle')),
    ...layersOf(data, 'packages').flatMap(duplicateIssues),
    ...data.errors.map((error, i): Issue => ({
      id: `error-${i}`,
      tone: 'warning',
      title: `${error.source} failed`,
      detail: error.message,
    })),
  ]
  const { items: shown, more } = capped(items, limits.issues, 'issues')
  return {
    id: 'issues',
    title: 'Issues',
    blocks:
      shown.length > 0
        ? [{ type: 'issues', items: shown }, ...more]
        : [{ type: 'markdown', text: 'No cycles or duplicated libraries.' }],
  }
}

function workspaceGraph(layer: LayerData): Block {
  const inCycle = new Set(layer.cycles.flatMap((cycle) => cycle.members))
  const cycleEdges = new Set(
    layer.cycles.flatMap((cycle) => cycle.path.slice(1).map((to, i) => `${cycle.path[i]}\0${to}`)),
  )
  const dependents = new Map<string, number>()
  for (const edge of layer.graph.edges) dependents.set(edge.to, (dependents.get(edge.to) ?? 0) + 1)
  const nodes: GraphNode[] = layer.graph.nodes.map((node) => ({
    id: node.id,
    label: node.name,
    group: node.ecosystem,
    ...(inCycle.has(node.id) ? { tone: 'bad' as const } : {}),
    size: dependents.get(node.id) ?? 0,
    ...(node.path ? { detail: node.path } : {}),
  }))
  const edges: GraphEdge[] = layer.graph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    ...(edge.kind === 'prod' ? {} : { label: edge.kind }),
    ...(edge.kind === 'dev' || edge.kind === 'peer' || edge.kind === 'optional'
      ? { dashed: true }
      : {}),
    ...(cycleEdges.has(`${edge.from}\0${edge.to}`) ? { tone: 'bad' as const } : {}),
  }))
  return {
    type: 'graph',
    title: `Workspaces (${layer.source})`,
    nodes,
    edges,
    highlight: layer.cycles.map((cycle) => cycle.path),
    layout: 'layered',
  }
}

function duplicatesSection(
  data: DepgraphData,
  previous?: DepgraphData,
  compareTo?: string,
): Section {
  const layers = layersOf(data, 'packages')
  const rows: Record<string, Cell>[] = []
  const all = layers.flatMap((layer) => layer.duplicates.map((duplicate) => ({ layer, duplicate })))
  const { items, more } = capped(all, limits.duplicates, 'duplicated libraries')
  for (const { layer, duplicate } of items) {
    const label = labeler(layer)
    for (const version of duplicate.versions)
      rows.push({
        library: duplicate.name,
        version:
          version.selected === undefined
            ? version.version
            : { text: versionText(version), tone: version.selected ? 'good' : 'neutral' },
        pulledInBy: version.dependents.map(label).join(', '),
        path: arrow(version.path, label),
      })
  }
  const blocks: Block[] = [
    rows.length > 0
      ? {
          type: 'table',
          columns: [
            { key: 'library', label: 'Library', format: 'code' },
            { key: 'version', label: 'Version', unit: 'version' },
            { key: 'pulledInBy', label: 'Pulled in by' },
            { key: 'path', label: 'Path', format: 'code' },
          ],
          rows,
          groupBy: 'library',
        }
      : { type: 'markdown', text: 'Every library is present in one version.' },
    ...more,
  ]

  if (previous) {
    const now = new Map(all.map(({ duplicate }) => [duplicateKey(duplicate), duplicate]))
    const before = new Map(
      layersOf(previous, 'packages').flatMap((layer) =>
        layer.duplicates.map((duplicate) => [duplicateKey(duplicate), duplicate] as const),
      ),
    )
    const changes: Record<string, Cell>[] = [
      ...[...now]
        .filter(([key]) => !before.has(key))
        .map(([, duplicate]) => ({
          library: duplicate.name,
          status: { text: 'new', tone: 'warning' as const },
          versions: duplicate.versions.map((version) => version.version).join(', '),
        })),
      ...[...before]
        .filter(([key]) => !now.has(key))
        .map(([, duplicate]) => ({
          library: duplicate.name,
          status: { text: 'resolved', tone: 'good' as const },
          versions: duplicate.versions.map((version) => version.version).join(', '),
        })),
    ]
    blocks.push(
      changes.length > 0
        ? {
            type: 'table',
            title: `Since ${compareTo ?? 'previous analysis'}`,
            columns: [
              { key: 'library', label: 'Library', format: 'code' },
              { key: 'status', label: 'Status' },
              { key: 'versions', label: 'Versions' },
            ],
            rows: changes,
          }
        : {
            type: 'markdown',
            text: `No duplicated libraries appeared or were resolved since ${compareTo ?? 'the previous analysis'}.`,
          },
    )
  }
  return {
    id: 'duplicates',
    title: 'Duplicates',
    description: 'Libraries resolved in more than one version.',
    blocks,
  }
}

function moduleCyclesSection(data: DepgraphData): Section {
  const items = layersOf(data, 'modules').flatMap((layer) => cycleIssues(layer, 'Cycle'))
  const { items: shown, more } = capped(items, limits.moduleCycles, 'module cycles')
  return {
    id: 'module-cycles',
    title: 'Module cycles',
    description: 'Source files that import each other, grouped by strongly connected component.',
    blocks:
      shown.length > 0
        ? [{ type: 'issues', items: shown }, ...more]
        : [{ type: 'markdown', text: 'No import cycles between source files.' }],
  }
}

function mostUsedSection(data: DepgraphData): Section {
  const blocks: Block[] = layersOf(data, 'packages').map((layer) => {
    const nodes = new Map(layer.graph.nodes.map((node) => [node.id, node]))
    return {
      type: 'table',
      title: `Most depended on (${layer.source})`,
      columns: [
        { key: 'package', label: 'Package', format: 'code' },
        { key: 'version', label: 'Version', unit: 'version' },
        { key: 'dependents', label: 'Dependents', unit: 'count', align: 'end' },
      ],
      rows: layer.stats.mostDependedOn.slice(0, limits.mostUsed).map((entry) => ({
        package: nodes.get(entry.id)?.name ?? entry.id,
        version: nodes.get(entry.id)?.version ?? null,
        dependents: entry.dependents,
      })),
    }
  })
  for (const layer of layersOf(data, 'packages'))
    if (layer.stats.deepestChain.length > 1)
      blocks.push({
        type: 'markdown',
        text: `Deepest chain (${layer.source}, ${layer.stats.deepestChain.length - 1} levels): \`${arrow(layer.stats.deepestChain, labeler(layer))}\``,
      })
  return { id: 'most-used', title: 'Most used', blocks }
}

function overviewSection(data: DepgraphData): Section {
  const packageLayers = layersOf(data, 'packages')
  const byEcosystem = new Map<string, Record<string, number>>()
  for (const layer of data.layers)
    for (const node of layer.graph.nodes) {
      if (layer.id !== 'packages' && node.kind !== 'module') continue
      const row = byEcosystem.get(node.ecosystem) ?? {}
      row[node.kind] = (row[node.kind] ?? 0) + 1
      byEcosystem.set(node.ecosystem, row)
    }
  return {
    id: 'overview',
    title: 'Packages overview',
    blocks: [
      {
        type: 'metrics',
        metrics: [
          metric(
            'direct',
            'Direct dependencies',
            sum(packageLayers, (layer) => layer.stats.direct),
          ),
          metric(
            'transitive',
            'Transitive dependencies',
            sum(packageLayers, (layer) => layer.stats.transitive),
          ),
          metric(
            'edges',
            'Dependency edges',
            sum(packageLayers, (layer) => layer.stats.edges),
          ),
        ],
      },
      {
        type: 'chart',
        title: 'Nodes by ecosystem',
        chart: 'stacked-bar',
        unit: 'count',
        x: 'ecosystem',
        series: [
          { key: 'workspace', label: 'Workspaces', tone: 'info' },
          { key: 'package', label: 'Packages', tone: 'neutral' },
          { key: 'module', label: 'Source files', tone: 'good' },
        ],
        data: [...byEcosystem].map(([ecosystem, row]) =>
          Object.assign({ ecosystem, workspace: 0, package: 0, module: 0 }, row),
        ),
      },
    ],
  }
}

/** Turns `DepgraphData` into a report. Exported for tests and for clients that render locally. */
export function depgraphReport(
  data: DepgraphData,
  options: { previous?: DepgraphData; ref?: string; compareTo?: string; generatedAt?: string } = {},
): Omit<Report, 'subject'> {
  const { previous, compareTo } = options
  const sections: Section[] = [issuesSection(data)]
  const workspaceLayers = layersOf(data, 'workspaces')
  if (workspaceLayers.length > 0)
    sections.push({
      id: 'workspaces',
      title: 'Workspaces',
      blocks: workspaceLayers.map(workspaceGraph),
    })
  sections.push(duplicatesSection(data, previous, compareTo))
  if (layersOf(data, 'modules').length > 0) sections.push(moduleCyclesSection(data))
  if (layersOf(data, 'packages').length > 0) sections.push(mostUsedSection(data))
  sections.push(overviewSection(data))
  return {
    kind: 'depgraph',
    title: 'Dependencies',
    ...(options.ref ? { subtitle: options.ref } : {}),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    metrics: metrics(data, previous),
    sections,
  }
}

/**
 * The `depgraph` analysis kind: dependency graphs of workspaces, packages and source modules,
 * with cycles and libraries present in several versions. Problem metrics carry `better: 'down'`.
 */
export const depgraphAnalysis = defineAnalysis<DepgraphData>({
  kind: 'depgraph',
  label: 'Dependencies',
  schema: depgraphDataSchema,
  summarize: (data) => metrics(data),
  toReport(current, previous) {
    return {
      ...depgraphReport(current.data, {
        previous: previous?.data,
        ref: current.ref,
        compareTo: previous?.ref,
      }),
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(previous?.ref ? { compareTo: previous.ref } : {}),
      },
    }
  },
})
