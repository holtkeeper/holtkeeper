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
import { APP, type BundleData, type BundleEntrypoint, UNMAPPED } from './data.ts'
import {
  type BundleAnalysisData,
  type BundleTarget,
  bundleAnalysisSchema,
  bundleTargets,
  totalSizes,
} from './targets.ts'

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

type Settings = Required<BundleAnalysisOptions>

const settingsOf = (options: BundleAnalysisOptions): Settings => ({
  growthPercent: options.growthPercent ?? 5,
  growthBytes: options.growthBytes ?? 10 * 1024,
  heavyPackageBytes: options.heavyPackageBytes ?? 5 * 1024,
  treemapModules: options.treemapModules ?? 30,
})

const label = (target: Pick<BundleTarget, 'name' | 'version'>) =>
  target.version ? `${target.name}@${target.version}` : target.name

/** One side of a target report: the target and the release it belongs to. */
export interface TargetSide {
  target: BundleTarget
  ref?: string
  repo?: NonNullable<Report['subject']>['repo']
}

function failedReport(current: TargetSide): Report {
  return {
    kind: 'bundle',
    title: `Bundle size · ${label(current.target)}`,
    ...(current.ref ? { subtitle: current.ref } : {}),
    subject: {
      ...(current.repo ? { repo: current.repo } : {}),
      ...(current.ref ? { ref: current.ref } : {}),
    },
    generatedAt: new Date().toISOString(),
    metrics: [],
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        blocks: [
          {
            type: 'issues',
            title: 'Not measured',
            items: [
              {
                id: `failed:${label(current.target)}`,
                tone: 'bad',
                title: `${label(current.target)} could not be measured`,
                ...(current.target.error ? { detail: current.target.error } : {}),
              },
            ],
          },
        ],
      },
    ],
  }
}

function packageSection(target: BundleTarget, previous: BundleTarget | undefined): Section[] {
  const info = target.package
  if (!info) return []
  const before = previous?.package
  return [
    {
      id: 'package',
      title: 'Package',
      description: 'The whole archive, declarations, docs and source maps included.',
      blocks: [
        {
          type: 'metrics',
          metrics: [
            metric('unpacked', 'Unpacked size', info.unpacked, {
              unit: 'bytes',
              better: 'down',
              ...(before ? { previous: before.unpacked } : {}),
            }),
            metric('files', 'Files', info.files, {
              better: 'down',
              ...(before ? { previous: before.files } : {}),
            }),
            metric('dependencies', 'Dependencies', info.dependencies.length, {
              better: 'down',
              ...(before ? { previous: before.dependencies.length } : {}),
            }),
          ],
        },
        ...(info.dependencies.length || info.peerDependencies.length
          ? [
              {
                type: 'table' as const,
                columns: [
                  { key: 'name', label: 'Dependency', format: 'code' as const },
                  { key: 'kind', label: 'Kind' },
                  { key: 'tags', label: 'Status', format: 'tags' as const },
                ],
                rows: [
                  ...info.dependencies.map((name) => ({ name, kind: 'dependency' })),
                  ...info.peerDependencies.map((name) => ({ name, kind: 'peer' })),
                ].map((row) => ({
                  ...row,
                  tags:
                    before &&
                    !(row.kind === 'peer' ? before.peerDependencies : before.dependencies).includes(
                      row.name,
                    )
                      ? 'added'
                      : '',
                })),
              },
            ]
          : []),
      ],
    },
  ]
}

/**
 * The full report of one target, compared with an earlier measurement of it: metrics, overview,
 * entrypoints, composition, packages and assets, and for published packages what the archive
 * weighs. A failed target reports its error.
 */
export function targetReport(
  current: TargetSide,
  previous?: TargetSide,
  options: BundleAnalysisOptions = {},
): Report {
  const data = current.target.data
  if (current.target.status !== 'ok' || !data) return failedReport(current)
  const settings = settingsOf(options)
  const before = previous?.target.status === 'ok' ? previous.target.data : undefined
  const comparison = before ? compareBundles(before, data) : undefined
  const compareTo = before && previous ? (previous.target.version ?? previous.ref) : undefined
  const subtitle = current.target.version ?? current.ref
  return {
    kind: 'bundle',
    title:
      current.target.source === 'package' || current.target.name !== 'app'
        ? `Bundle size · ${current.target.name}`
        : 'Bundle size',
    ...(subtitle ? { subtitle } : {}),
    subject: {
      ...(current.repo ? { repo: current.repo } : {}),
      ...(current.ref ? { ref: current.ref } : {}),
      ...(compareTo ? { compareTo } : {}),
    },
    generatedAt: new Date().toISOString(),
    metrics: metricsOf(data, before),
    sections: [
      overview(data, before, comparison, settings),
      ...packageSection(current.target, before ? previous?.target : undefined),
      entrypointsSection(data, comparison),
      compositionSection(data, settings.treemapModules),
      packagesSection(data, comparison),
      assetsSection(data, comparison),
    ],
  }
}

const okGzip = (targets: BundleTarget[]) =>
  targets.reduce((sum, target) => sum + (target.data ? totalSizes(target.data).gzip : 0), 0)

const failedCount = (list: BundleTarget[]) => list.filter((target) => target.status !== 'ok').length

function targetsMetrics(targets: BundleTarget[], previous?: BundleTarget[]): Metric[] {
  return [
    metric('total-gzip', 'Total (gzip)', okGzip(targets), {
      unit: 'bytes',
      better: 'down',
      ...(previous ? { previous: okGzip(previous) } : {}),
    }),
    metric('targets', 'Targets', targets.length, previous ? { previous: previous.length } : {}),
    metric('failed', 'Not measured', failedCount(targets), {
      better: 'down',
      ...(previous ? { previous: failedCount(previous) } : {}),
    }),
  ]
}

function targetsSection(
  targets: BundleTarget[],
  previous: BundleTarget[] | undefined,
  settings: Settings,
): Section {
  const before = new Map(
    (previous ?? []).filter((target) => target.data).map((target) => [target.name, target]),
  )
  const issues: Issue[] = []
  const rows = targets.map((target) => {
    const total = target.data ? totalSizes(target.data) : undefined
    const was = before.get(target.name)?.data
    const wasTotal = was ? totalSizes(was) : undefined
    const delta = total && wasTotal ? total.gzip - wasTotal.gzip : undefined
    const main = target.data ? mainEntrypoint(target.data) : undefined
    if (target.status !== 'ok')
      issues.push({
        id: `failed:${label(target)}`,
        tone: 'bad',
        title: `${label(target)} could not be measured`,
        ...(target.error ? { detail: target.error } : {}),
      })
    else if (total && wasTotal && delta !== undefined) {
      const percent = percentChange(wasTotal.gzip, total.gzip) ?? 0
      if (Math.abs(percent) > settings.growthPercent && Math.abs(delta) > settings.growthBytes)
        issues.push({
          id: `target:${target.name}`,
          tone: delta > 0 ? 'warning' : 'good',
          title: `${label(target)} ${delta > 0 ? 'grew' : 'shrank'} by ${formatBytes(Math.abs(delta))} gzip${signedPercent(percent)}`,
        })
    }
    return {
      name: target.name,
      version: target.version ?? '',
      source: target.source,
      raw: total?.raw ?? null,
      gzip: total?.gzip ?? null,
      brotli: total?.brotli ?? null,
      delta: deltaCell(delta),
      initial: main?.initialSize.gzip ?? null,
      entrypoints: target.data?.entrypoints.length ?? null,
      tags: target.status === 'ok' ? '' : 'failed',
    }
  })
  return {
    id: 'targets',
    title: 'Targets',
    description: 'Every build and published package version this run measured.',
    blocks: [
      ...(issues.length ? [{ type: 'issues' as const, title: 'Notable', items: issues }] : []),
      {
        type: 'table',
        columns: [
          { key: 'name', label: 'Target', format: 'code' },
          { key: 'version', label: 'Version' },
          { key: 'source', label: 'Source' },
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
          { key: 'initial', label: 'Largest initial (gzip)', unit: 'bytes', align: 'end' },
          { key: 'entrypoints', label: 'Entrypoints', unit: 'count', align: 'end' },
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
): AnalysisKind<BundleAnalysisData> {
  const settings = settingsOf(options)
  return defineAnalysis<BundleAnalysisData>({
    kind: 'bundle',
    label: 'Bundle size',
    schema: bundleAnalysisSchema,
    summarize(data) {
      const targets = bundleTargets(data)
      const only = targets.length === 1 ? targets[0] : undefined
      return only?.data ? metricsOf(only.data) : targetsMetrics(targets)
    },
    toReport(current, previous): Report {
      const targets = bundleTargets(current.data)
      const before = previous ? bundleTargets(previous.data) : undefined
      const only = targets.length === 1 ? targets[0] : undefined
      if (only) {
        const match = before?.find((target) => target.name === only.name)
        return targetReport(
          { target: only, repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
          match && { target: match, ...(previous?.ref ? { ref: previous.ref } : {}) },
          settings,
        )
      }
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
        metrics: targetsMetrics(targets, before),
        sections: [
          targets.length
            ? targetsSection(targets, before, settings)
            : {
                id: 'targets',
                title: 'Targets',
                blocks: [
                  {
                    type: 'markdown',
                    text: 'Nothing new to measure: every published version was measured before.',
                  },
                ],
              },
        ],
      }
    },
  })
}

/** Bundle sizes per target, entrypoint, asset and package, compared with the previous release. */
export const bundleAnalysis: AnalysisKind<BundleAnalysisData> = createBundleAnalysis()
