import {
  type AnalysisKind,
  type Cell,
  type Issue,
  type Metric,
  type Report,
  type Section,
  type TreeNode,
  defineAnalysis,
  formatBytes,
  metric,
  percentChange,
} from '@holtkeeper/report'

import { type BundleComparison, compareBundles } from './compare.ts'
import { APP, type BundleData, type BundleEntrypoint, UNMAPPED, bundleDataSchema } from './data.ts'

/** Thresholds that decide which changes the overview calls out. */
export interface BundleAnalysisOptions {
  /** Growth of an entrypoint's initial gzip size, in percent, worth a warning. Default 5. */
  growthPercent?: number
  /** Growth in gzip bytes worth a warning regardless of percent. Default 10 kB. */
  growthBytes?: number
  /** Gzip size from which a newly added package counts as heavy. Default 5 kB. */
  heavyPackageBytes?: number
  /** App modules shown per entrypoint in the treemap before the rest is grouped. Default 30. */
  treemapModules?: number
}

const sumGzip = (data: BundleData, kind: 'js' | 'css') =>
  data.assets.filter((asset) => asset.kind === kind).reduce((total, asset) => total + asset.gzip, 0)

const isNpmPackage = (name: string) => !name.startsWith('(')

const countPackages = (bundle: BundleData) =>
  bundle.packages.filter((pkg) => isNpmPackage(pkg.name)).length

/** The entrypoint with the largest initial gzip size: the one most users pay for. */
export function mainEntrypoint(data: BundleData): BundleEntrypoint | undefined {
  return data.entrypoints.toSorted(
    (a, b) => b.initialSize.gzip - a.initialSize.gzip || a.name.localeCompare(b.name),
  )[0]
}

function metricsOf(data: BundleData, previous?: BundleData): Metric[] {
  const main = mainEntrypoint(data)
  const previousMain = previous
    ? (previous.entrypoints.find((entry) => entry.name === main?.name) ?? mainEntrypoint(previous))
    : undefined
  const was = <T>(value: T | undefined) => (previous === undefined ? {} : { previous: value })
  return [
    metric('js-gzip', 'JS (gzip)', sumGzip(data, 'js'), {
      unit: 'bytes',
      better: 'down',
      ...was(previous && sumGzip(previous, 'js')),
    }),
    metric('css-gzip', 'CSS (gzip)', sumGzip(data, 'css'), {
      unit: 'bytes',
      better: 'down',
      ...was(previous && sumGzip(previous, 'css')),
    }),
    metric('initial-gzip', 'Initial load (gzip)', main?.initialSize.gzip ?? 0, {
      unit: 'bytes',
      better: 'down',
      ...was(previousMain?.initialSize.gzip),
      ...(main ? { hint: `Entrypoint ${main.name}` } : {}),
    }),
    metric('entrypoints', 'Entrypoints', data.entrypoints.length, {
      ...was(previous?.entrypoints.length),
    }),
    metric('packages', 'Packages', countPackages(data), {
      better: 'down',
      ...was(previous && countPackages(previous)),
    }),
  ]
}

const signedBytes = (bytes: number) => `${bytes > 0 ? '+' : ''}${formatBytes(bytes)}`
const signedPercent = (value: number | undefined) =>
  value === undefined ? '' : ` (${value > 0 ? '+' : ''}${value.toFixed(1)}%)`

function issuesOf(
  data: BundleData,
  comparison: BundleComparison | undefined,
  options: Required<BundleAnalysisOptions>,
) {
  const issues: Issue[] = []
  if (comparison) {
    for (const entry of comparison.entrypoints) {
      if (!entry.previous || !entry.current) continue
      const delta = entry.delta.gzip
      const percent = percentChange(entry.previous.gzip, entry.current.gzip) ?? 0
      const overPercent = Math.abs(percent) > options.growthPercent
      const overBytes = Math.abs(delta) > options.growthBytes
      if (!overPercent && !overBytes) continue
      const grew = delta > 0
      issues.push({
        id: `entrypoint:${entry.name}`,
        tone: grew ? (overPercent && overBytes ? 'bad' : 'warning') : 'good',
        title: `Initial load of ${entry.name} ${grew ? 'grew' : 'shrank'} by ${formatBytes(Math.abs(delta))} gzip${signedPercent(percent)}`,
        detail: `${formatBytes(entry.previous.gzip)} → ${formatBytes(entry.current.gzip)}`,
        tags: ['entrypoint'],
      })
    }
    for (const pkg of comparison.packages) {
      if (!isNpmPackage(pkg.name)) continue
      if (pkg.status === 'added' && (pkg.current?.gzip ?? 0) >= options.heavyPackageBytes) {
        issues.push({
          id: `package-added:${pkg.name}`,
          tone: 'warning',
          title: `New package ${pkg.name} adds ${formatBytes(pkg.current?.gzip ?? 0)} gzip`,
          tags: ['package', 'added'],
        })
      } else if (pkg.status === 'grown' && pkg.delta.gzip > options.growthBytes) {
        issues.push({
          id: `package-grown:${pkg.name}`,
          tone: 'warning',
          title: `${pkg.name} grew by ${signedBytes(pkg.delta.gzip)} gzip`,
          tags: ['package'],
        })
      }
      if (pkg.newlyDuplicated) {
        const current = data.packages.find((item) => item.name === pkg.name)
        const variants = current?.versions.length ? current.versions : (current?.instances ?? [])
        issues.push({
          id: `package-duplicated:${pkg.name}`,
          tone: 'warning',
          title: `${pkg.name} is now bundled ${variants.length} times`,
          detail: variants.join(', '),
          tags: ['package', 'duplicate'],
        })
      }
    }
  } else {
    for (const pkg of data.packages) {
      const variants = pkg.versions.length > 1 ? pkg.versions : pkg.instances
      if (variants.length < 2) continue
      issues.push({
        id: `package-duplicated:${pkg.name}`,
        tone: 'warning',
        title: `${pkg.name} is bundled ${variants.length} times`,
        detail: variants.join(', '),
        tags: ['package', 'duplicate'],
      })
    }
  }
  const rank = { bad: 0, warning: 1, info: 2, neutral: 3, good: 4 }
  return issues.toSorted((a, b) => rank[a.tone] - rank[b.tone])
}

const deltaCell = (value: number | undefined): Cell => (value === undefined ? null : value)

function overview(
  data: BundleData,
  previous: BundleData | undefined,
  comparison: BundleComparison | undefined,
  options: Required<BundleAnalysisOptions>,
): Section {
  const issues = issuesOf(data, comparison, options)
  const names = [
    ...new Set([
      ...data.entrypoints.map((entry) => entry.name),
      ...(previous?.entrypoints.map((entry) => entry.name) ?? []),
    ]),
  ]
  const chartData = names.map((name) => ({
    entrypoint: name,
    current: data.entrypoints.find((entry) => entry.name === name)?.initialSize.gzip ?? 0,
    ...(previous
      ? {
          previous:
            previous.entrypoints.find((entry) => entry.name === name)?.initialSize.gzip ?? 0,
        }
      : {}),
  }))
  return {
    id: 'overview',
    title: 'Overview',
    ...(data.tool ? { description: `Built with ${data.tool}.` } : {}),
    blocks: [
      {
        type: 'chart',
        title: 'Initial load per entrypoint (gzip)',
        chart: 'bar',
        unit: 'bytes',
        x: 'entrypoint',
        series: [
          ...(previous ? [{ key: 'previous', label: 'Previous', tone: 'neutral' as const }] : []),
          { key: 'current', label: 'Current', tone: 'info' },
        ],
        data: chartData,
      },
      issues.length
        ? { type: 'issues', title: 'Notable changes', items: issues }
        : { type: 'markdown', text: previous ? 'No notable size changes.' : 'No issues found.' },
    ],
  }
}

function entrypointsSection(data: BundleData, comparison: BundleComparison | undefined): Section {
  const changes = new Map(comparison?.entrypoints.map((entry) => [entry.name, entry]))
  const rows = data.entrypoints.map((entry) => {
    const change = changes.get(entry.name)
    return {
      name: entry.name,
      raw: entry.initialSize.raw,
      gzip: entry.initialSize.gzip,
      brotli: entry.initialSize.brotli,
      delta: deltaCell(change?.previous ? change.delta.gzip : undefined),
      lazy: entry.lazySize.gzip,
      lazyDelta: deltaCell(change?.lazy.previous ? change.lazy.delta.gzip : undefined),
      assets: entry.initial.length,
      tags: change?.status === 'added' ? 'added' : '',
    }
  })
  for (const change of comparison?.entrypoints ?? []) {
    if (change.status !== 'removed') continue
    rows.push({
      name: change.name,
      raw: 0,
      gzip: 0,
      brotli: 0,
      delta: change.delta.gzip,
      lazy: 0,
      lazyDelta: change.lazy.delta.gzip,
      assets: 0,
      tags: 'removed',
    })
  }
  const assets = new Map(data.assets.map((asset) => [asset.file, asset]))
  const lazyRows = data.entrypoints.flatMap((entry) =>
    entry.lazy.flatMap((file) => {
      const asset = assets.get(file)
      return asset
        ? [
            {
              entrypoint: entry.name,
              name: asset.name,
              kind: asset.kind,
              raw: asset.raw,
              gzip: asset.gzip,
              brotli: asset.brotli,
            },
          ]
        : []
    }),
  )
  return {
    id: 'entrypoints',
    title: 'Entrypoints',
    description: 'Initial load is everything a first visit downloads; lazy chunks load on demand.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'name', label: 'Entrypoint', format: 'code' },
          { key: 'raw', label: 'Raw', unit: 'bytes', align: 'end' },
          { key: 'gzip', label: 'Gzip', unit: 'bytes', align: 'end' },
          { key: 'brotli', label: 'Brotli', unit: 'bytes', align: 'end' },
          {
            key: 'delta',
            label: 'Δ gzip',
            unit: 'bytes',
            format: 'delta',
            better: 'down',
            align: 'end',
          },
          { key: 'lazy', label: 'Lazy (gzip)', unit: 'bytes', align: 'end' },
          {
            key: 'lazyDelta',
            label: 'Δ lazy',
            unit: 'bytes',
            format: 'delta',
            better: 'down',
            align: 'end',
          },
          { key: 'assets', label: 'Initial files', unit: 'count', align: 'end' },
          { key: 'tags', label: 'Status', format: 'tags' },
        ],
        rows,
      },
      ...(lazyRows.length
        ? [
            {
              type: 'table' as const,
              title: 'Lazy chunks',
              groupBy: 'entrypoint',
              columns: [
                { key: 'entrypoint', label: 'Entrypoint', format: 'code' as const },
                { key: 'name', label: 'Asset', format: 'code' as const },
                { key: 'kind', label: 'Kind' },
                { key: 'raw', label: 'Raw', unit: 'bytes' as const, align: 'end' as const },
                { key: 'gzip', label: 'Gzip', unit: 'bytes' as const, align: 'end' as const },
                { key: 'brotli', label: 'Brotli', unit: 'bytes' as const, align: 'end' as const },
              ],
              rows: lazyRows,
            },
          ]
        : []),
    ],
  }
}

function compositionSection(data: BundleData, limit: number): Section {
  const children = data.entrypoints.map((entry): TreeNode => {
    const modules = entry.modules
      .slice(0, limit)
      .map((module) => ({ name: module.name, value: module.bytes }))
    const rest = entry.modules.slice(limit).reduce((total, module) => total + module.bytes, 0)
    if (rest > 0) modules.push({ name: 'other modules', value: rest })
    return {
      name: entry.name,
      children: entry.packages
        .filter((pkg) => pkg.bytes > 0)
        .map((pkg): TreeNode =>
          pkg.name === APP
            ? { name: APP, tone: 'info', children: modules }
            : {
                name: pkg.name,
                value: pkg.bytes,
                ...(pkg.name === UNMAPPED ? { tone: 'neutral' as const } : {}),
              },
        ),
    }
  })
  return {
    id: 'composition',
    title: 'Composition',
    description:
      'Raw JS and CSS bytes of each entrypoint (initial and lazy) by npm package and app module, from source maps.',
    blocks: [
      {
        type: 'treemap',
        title: 'Entrypoint → package / module',
        unit: 'bytes',
        root: { name: 'bundle', children },
      },
    ],
  }
}

function packagesSection(data: BundleData, comparison: BundleComparison | undefined): Section {
  const changes = new Map(comparison?.packages.map((pkg) => [pkg.name, pkg]))
  const codeGzip = sumGzip(data, 'js') + sumGzip(data, 'css')
  const rows: Record<string, Cell>[] = data.packages.map((pkg) => {
    const change = changes.get(pkg.name)
    const variants = pkg.versions.length ? pkg.versions : pkg.instances
    const tags = [
      ...(change?.status === 'added' ? ['added'] : []),
      ...(variants.length > 1 ? ['duplicate'] : []),
    ]
    return {
      name: pkg.name,
      versions: pkg.versions.join(', '),
      bytes: pkg.bytes,
      gzip: pkg.gzip,
      delta: deltaCell(comparison ? (change?.delta.gzip ?? 0) : undefined),
      share: codeGzip ? (pkg.gzip / codeGzip) * 100 : 0,
      entrypoints: pkg.entrypoints.join(', '),
      tags: tags.join(', '),
    }
  })
  for (const change of comparison?.packages ?? []) {
    if (change.status !== 'removed') continue
    rows.push({
      name: change.name,
      versions: '',
      bytes: 0,
      gzip: 0,
      delta: change.delta.gzip,
      share: 0,
      entrypoints: '',
      tags: 'removed',
    })
  }
  return {
    id: 'packages',
    title: 'Packages',
    description: 'Gzip sizes of packages are estimated from their share of each asset.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'name', label: 'Package', format: 'code' },
          { key: 'versions', label: 'Versions', format: 'tags' },
          { key: 'bytes', label: 'Raw', unit: 'bytes', align: 'end' },
          { key: 'gzip', label: 'Gzip (est.)', unit: 'bytes', align: 'end' },
          {
            key: 'delta',
            label: 'Δ gzip',
            unit: 'bytes',
            format: 'delta',
            better: 'down',
            align: 'end',
          },
          { key: 'share', label: 'Share', unit: 'percent', align: 'end' },
          { key: 'entrypoints', label: 'Entrypoints', format: 'tags' },
          { key: 'tags', label: 'Status', format: 'tags' },
        ],
        rows,
      },
    ],
  }
}

function assetsSection(data: BundleData, comparison: BundleComparison | undefined): Section {
  const changes = new Map(comparison?.assets.map((asset) => [asset.name, asset]))
  const rows: Record<string, Cell>[] = data.assets.map((asset) => {
    const change = changes.get(asset.name)
    return {
      name: asset.name,
      file: asset.file,
      kind: asset.kind,
      raw: asset.raw,
      gzip: asset.gzip,
      brotli: asset.brotli,
      delta: deltaCell(comparison ? (change?.delta.gzip ?? 0) : undefined),
      tags: change && change.status !== 'unchanged' ? change.status : '',
    }
  })
  for (const change of comparison?.assets ?? []) {
    if (change.status !== 'removed') continue
    rows.push({
      name: change.name,
      file: change.previousFile ?? '',
      kind: change.kind,
      raw: 0,
      gzip: 0,
      brotli: 0,
      delta: change.delta.gzip,
      tags: 'removed',
    })
  }
  return {
    id: 'assets',
    title: 'Assets',
    description: 'Files are matched across builds by name without content hashes.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'name', label: 'Asset', format: 'code' },
          { key: 'file', label: 'File', format: 'code' },
          { key: 'kind', label: 'Kind' },
          { key: 'raw', label: 'Raw', unit: 'bytes', align: 'end' },
          { key: 'gzip', label: 'Gzip', unit: 'bytes', align: 'end' },
          { key: 'brotli', label: 'Brotli', unit: 'bytes', align: 'end' },
          {
            key: 'delta',
            label: 'Δ gzip',
            unit: 'bytes',
            format: 'delta',
            better: 'down',
            align: 'end',
          },
          { key: 'tags', label: 'Status', format: 'tags' },
        ],
        rows,
      },
    ],
  }
}

/** The `bundle` analysis kind with custom thresholds. */
export function createBundleAnalysis(
  options: BundleAnalysisOptions = {},
): AnalysisKind<BundleData> {
  const settings: Required<BundleAnalysisOptions> = {
    growthPercent: options.growthPercent ?? 5,
    growthBytes: options.growthBytes ?? 10 * 1024,
    heavyPackageBytes: options.heavyPackageBytes ?? 5 * 1024,
    treemapModules: options.treemapModules ?? 30,
  }
  return defineAnalysis<BundleData>({
    kind: 'bundle',
    label: 'Bundle size',
    schema: bundleDataSchema,
    summarize: (data) => metricsOf(data),
    toReport(current, previous): Report {
      const data = current.data
      const before = previous?.data
      const comparison = before ? compareBundles(before, data) : undefined
      return {
        kind: 'bundle',
        title: 'Bundle size',
        ...(current.ref ? { subtitle: current.ref } : {}),
        subject: {
          repo: current.repo,
          ...(current.ref ? { ref: current.ref } : {}),
          ...(previous?.ref ? { compareTo: previous.ref } : {}),
        },
        generatedAt: new Date().toISOString(),
        metrics: metricsOf(data, before),
        sections: [
          overview(data, before, comparison, settings),
          entrypointsSection(data, comparison),
          compositionSection(data, settings.treemapModules),
          packagesSection(data, comparison),
          assetsSection(data, comparison),
        ],
      }
    },
  })
}

/** Bundle sizes per entrypoint, asset and package, compared with the previous release. */
export const bundleAnalysis: AnalysisKind<BundleData> = createBundleAnalysis()
