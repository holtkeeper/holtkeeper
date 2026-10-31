import { changeItem } from '@holtkeeper/media'
import {
  type AnalysisKind,
  type Cell,
  type Issue,
  type Metric,
  type Report,
  type ReportExclude,
  type Section,
  type TreeNode,
  defineAnalysis,
  formatBytes,
  metric,
} from '@holtkeeper/report'

import { overBudgetCount } from './budgets.ts'
import { type AssetComparison, compareAssets } from './compare.ts'
import {
  type Asset,
  type AssetKind,
  type AssetsData,
  type BudgetViolation,
  type ImageOptimization,
  assetsDataSchema,
} from './data.ts'
import { wasted } from './findings.ts'

/** Display settings of the report. */
export interface AssetsAnalysisOptions {
  /** Rows of the largest-assets table. Default 25. */
  largest?: number
  /** Files shown per folder in the treemap before the rest is grouped. Default 40. */
  treemapFiles?: number
  /** Per-image variant cards in the optimization section. Default 10. */
  imageCards?: number
}

const kindLabels: Record<AssetKind, string> = {
  image: 'Images',
  audio: 'Audio',
  video: 'Video',
  font: 'Fonts',
  atlas: 'Atlases',
  model: 'Models',
  data: 'Data',
  other: 'Other',
}

const totalBytes = (data: AssetsData) => data.totals.reduce((total, kind) => total + kind.bytes, 0)
const savingsOf = (data: AssetsData) =>
  data.suggestions.reduce((total, suggestion) => total + suggestion.saving, 0)
const wastedOf = (data: AssetsData) =>
  data.duplicates.reduce((total, group) => total + wasted(group), 0)

function metricsOf(data: AssetsData, previous?: AssetsData): Metric[] {
  const was = (value: number | undefined) =>
    previous === undefined ? {} : { previous: value ?? 0 }
  const previousKinds = new Map(previous?.totals.map((total) => [total.kind, total.bytes]))
  const kinds = [
    ...new Set([
      ...data.totals.map((total) => total.kind),
      ...(previous?.totals.map((total) => total.kind) ?? []),
    ]),
  ]
  const duplicateBytes = wastedOf(data)
  return [
    metric('total', 'Total assets', totalBytes(data), {
      unit: 'bytes',
      better: 'down',
      ...was(previous && totalBytes(previous)),
      hint: `${data.totals.reduce((total, kind) => total + kind.count, 0)} files`,
    }),
    ...kinds.map((kind) =>
      metric(
        `kind:${kind}`,
        kindLabels[kind],
        data.totals.find((total) => total.kind === kind)?.bytes ?? 0,
        {
          unit: 'bytes',
          better: 'down',
          ...was(previousKinds.get(kind)),
        },
      ),
    ),
    {
      ...metric('over-budget', 'Over budget', overBudgetCount(data.budgets), {
        better: 'down',
        ...was(previous && overBudgetCount(previous.budgets)),
      }),
      tone: data.budgets.length ? 'bad' : 'good',
    },
    ...(data.changes || previous?.changes
      ? [
          metric('changes', 'Proposed changes', data.changes?.length ?? 0, {
            better: 'down',
            ...was(previous && (previous.changes?.length ?? 0)),
          }),
        ]
      : []),
    metric('savings', 'Potential savings', savingsOf(data), {
      unit: 'bytes',
      better: 'down',
      ...was(previous && savingsOf(previous)),
      ...(duplicateBytes ? { hint: `plus ${formatBytes(duplicateBytes)} in duplicates` } : {}),
    }),
  ]
}

/** `1920×1080`, `2.4 s · 44.1 kHz stereo`, `woff2 · 312 glyphs`, `48 frames`. */
export function detailsOf(asset: Asset): string {
  const parts: string[] = []
  const size = asset.image ?? asset.video
  if (size?.width && size.height) parts.push(`${size.width}×${size.height}`)
  if (asset.image?.animated) parts.push(`${asset.image.frames ?? 'animated'} frames`)
  const duration = asset.audio?.durationMs ?? asset.video?.durationMs
  if (duration !== undefined)
    parts.push(`${(duration / 1000).toFixed(duration < 10_000 ? 2 : 1)} s`)
  if (asset.audio?.sampleRate) {
    const channels =
      asset.audio.channels === 1
        ? 'mono'
        : asset.audio.channels === 2
          ? 'stereo'
          : `${asset.audio.channels ?? '?'} ch`
    parts.push(`${asset.audio.sampleRate / 1000} kHz ${channels}`)
  }
  if (asset.audio?.bitrate) parts.push(`${Math.round(asset.audio.bitrate / 1000)} kbit/s`)
  if (asset.font)
    parts.push(
      asset.font.glyphs === undefined
        ? asset.font.format
        : `${asset.font.format} · ${asset.font.glyphs} glyphs`,
    )
  if (asset.atlas?.frames !== undefined) parts.push(`${asset.atlas.frames} frames`)
  return parts.join(' · ')
}

function tagsOf(asset: Asset): string {
  return [
    ...(asset.image?.alpha && asset.image.codec !== 'vector' ? ['alpha'] : []),
    ...(asset.image?.animated ? ['animated'] : []),
    ...(asset.referenced === false ? ['unused?'] : []),
    ...(asset.origin === 'build' ? ['build'] : []),
  ].join(', ')
}

/** Folder → file tree of asset bytes; folders keep their `limit` largest files. */
export function assetTree(assets: readonly Asset[], limit: number): TreeNode {
  interface Folder {
    folders: Map<string, Folder>
    files: TreeNode[]
  }
  const root: Folder = { folders: new Map(), files: [] }
  for (const asset of assets) {
    const parts = asset.path.split('/')
    const name = parts.pop() ?? asset.path
    let folder = root
    for (const part of parts) {
      let child = folder.folders.get(part)
      if (!child) {
        child = { folders: new Map(), files: [] }
        folder.folders.set(part, child)
      }
      folder = child
    }
    folder.files.push({
      name,
      value: asset.bytes,
      ...(asset.referenced === false ? { tone: 'warning' } : {}),
    })
  }
  const build = (name: string, folder: Folder): TreeNode => {
    const files = folder.files.toSorted((a, b) => (b.value ?? 0) - (a.value ?? 0))
    const kept = files.slice(0, limit)
    const rest = files.slice(limit)
    if (rest.length) {
      kept.push({
        name: `${rest.length} more files`,
        value: rest.reduce((total, file) => total + (file.value ?? 0), 0),
        tone: 'neutral',
      })
    }
    return {
      name,
      children: [...[...folder.folders].map(([child, sub]) => build(child, sub)), ...kept],
    }
  }
  return build('assets', root)
}

function overview(data: AssetsData, previous: AssetsData | undefined, limit: number): Section {
  const kinds = [
    ...new Set([
      ...data.totals.map((total) => total.kind),
      ...(previous?.totals.map((total) => total.kind) ?? []),
    ]),
  ]
  const description = [
    `Scanned ${data.roots.map((root) => `\`${root}\``).join(', ')}.`,
    ...(data.engines.length ? [`Game engine: ${data.engines.join(', ')}.`] : []),
  ].join(' ')
  return {
    id: 'overview',
    title: 'Overview',
    description,
    blocks: [
      {
        type: 'chart',
        title: 'Bytes by kind',
        chart: 'bar',
        unit: 'bytes',
        x: 'kind',
        series: [
          ...(previous ? [{ key: 'previous', label: 'Previous', tone: 'neutral' as const }] : []),
          { key: 'current', label: 'Current', tone: 'info' },
        ],
        data: kinds.map((kind) => ({
          kind: kindLabels[kind],
          current: data.totals.find((total) => total.kind === kind)?.bytes ?? 0,
          ...(previous
            ? { previous: previous.totals.find((total) => total.kind === kind)?.bytes ?? 0 }
            : {}),
        })),
      },
      {
        type: 'treemap',
        title: 'Folder → file',
        unit: 'bytes',
        root: assetTree(data.assets, limit),
      },
    ],
  }
}

const limitLabels: Record<BudgetViolation['limit'], string> = {
  bytes: 'size',
  width: 'width',
  height: 'height',
  total: 'total size',
}

const formatLimit = (violation: BudgetViolation, value: number) =>
  violation.limit === 'width' || violation.limit === 'height' ? `${value} px` : formatBytes(value)

function budgetsSection(
  data: AssetsData,
  previous: AssetsData | undefined,
  comparison: AssetComparison | undefined,
): Section {
  const fresh = new Set(comparison?.newViolations)
  const items: Issue[] = data.budgets.map((violation) => ({
    id: violation.id,
    tone: 'bad',
    title: violation.path
      ? `${violation.path} ${limitLabels[violation.limit]} ${formatLimit(violation, violation.actual)} exceeds ${formatLimit(violation, violation.max)}`
      : `${kindLabels[violation.kind ?? 'other']} total ${formatBytes(violation.actual)} exceeds ${formatBytes(violation.max)}`,
    ...(violation.pattern
      ? { detail: `Budget \`${violation.pattern}\`${violation.kind ? ` (${violation.kind})` : ''}` }
      : {}),
    tags: ['budget', ...(fresh.has(violation.id) && comparison ? ['new'] : [])],
  }))
  const resolved = new Set(comparison?.resolvedViolations)
  for (const violation of previous?.budgets ?? []) {
    if (!resolved.has(violation.id)) continue
    const subject = violation.path ?? `${kindLabels[violation.kind ?? 'other']} total`
    items.push({
      id: `resolved:${violation.id}`,
      tone: 'good',
      title: `${subject} is back within its ${limitLabels[violation.limit]} budget`,
      tags: ['budget', 'resolved'],
    })
  }
  for (const finding of data.findings) {
    if (finding.rule === 'unused' || deliveryRules.has(finding.rule)) continue
    items.push({
      id: finding.id,
      tone: finding.tone,
      title: finding.title,
      ...(finding.detail ? { detail: finding.detail } : {}),
      tags: [finding.rule],
    })
  }
  return {
    id: 'budgets',
    title: 'Budgets',
    description:
      'Configured size and dimension budgets, plus textures too large or oddly sized for GPUs.',
    blocks: [
      items.length
        ? { type: 'issues', items }
        : { type: 'markdown', text: 'All assets are within budget.' },
    ],
  }
}

function suggestionsSection(data: AssetsData): Section {
  const unused = data.findings.filter((finding) => finding.rule === 'unused')
  const method =
    data.convert === 'off'
      ? 'Conversion suggestions are turned off.'
      : data.tools.length
        ? `Savings marked measured were produced with ${data.tools.join(', ')}; the rest are conservative estimates.`
        : 'Savings are conservative estimates; run with `convert: sharp` or `convert: tools` to measure them.'
  return {
    id: 'suggestions',
    title: 'Suggestions',
    description: method,
    blocks: [
      data.suggestions.length
        ? {
            type: 'table',
            columns: [
              { key: 'path', label: 'Asset', format: 'code', path: true },
              { key: 'current', label: 'Current', unit: 'bytes', align: 'end' },
              { key: 'suggested', label: 'Suggested', format: 'code' },
              { key: 'how', label: 'How' },
              { key: 'expected', label: 'Expected', unit: 'bytes', align: 'end' },
              { key: 'saving', label: 'Saving', unit: 'bytes', align: 'end' },
              { key: 'method', label: 'Method', format: 'tags' },
            ],
            rows: data.suggestions.map((suggestion) => ({
              path: suggestion.path,
              current: suggestion.bytes,
              suggested: `${suggestion.format} → ${suggestion.suggested}`,
              how: suggestion.how,
              expected: suggestion.expectedBytes,
              saving: suggestion.saving,
              method: suggestion.method === 'measured' ? 'measured' : 'estimated',
            })),
          }
        : { type: 'markdown', text: 'No conversions worth suggesting.' },
      ...(unused.length
        ? [
            {
              type: 'issues' as const,
              title: 'Possibly unused',
              items: unused.map((finding) => ({
                id: finding.id,
                tone: finding.tone,
                title: finding.title,
                ...(finding.detail ? { detail: finding.detail } : {}),
                tags: ['unused'],
              })),
            },
          ]
        : []),
    ],
  }
}

const formatNames: Record<string, string> = {
  avif: 'AVIF',
  webp: 'WebP',
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
}

const fullSize = (image: ImageOptimization, format: string) => {
  const list = image.variants.filter((variant) => variant.format === format)
  return list.toSorted((a, b) => b.width - a.width)[0]
}

const percentCell = (original: number, bytes: number | undefined): Cell => {
  if (bytes === undefined) return null
  const value = original > 0 ? Math.round(((original - bytes) / original) * 1000) / 10 : 0
  return {
    text: `${value > 0 ? '−' : '+'}${Math.abs(value)}%`,
    tone: value >= 10 ? 'good' : value > 0 ? 'neutral' : 'bad',
  }
}

function imageCard(image: ImageOptimization): Section['blocks'][number] {
  const formats = [...new Set(image.variants.map((variant) => variant.format))]
  return {
    type: 'table',
    title: `${image.path}${image.width ? ` · ${image.width}×${image.height}` : ''}${image.usage ? ` · ${image.usage}` : ''}`,
    columns: [
      { key: 'format', label: 'Format' },
      { key: 'sizes', label: 'Widths' },
      { key: 'full', label: 'Full size', unit: 'bytes', align: 'end' },
      { key: 'smallest', label: 'Smallest', unit: 'bytes', align: 'end' },
      { key: 'saving', label: 'Saving', align: 'end' },
      { key: 'quality', label: 'Quality', align: 'end' },
      { key: 'status', label: 'Status', format: 'tags' },
    ],
    rows: [
      {
        format: `original ${image.format}`,
        sizes: image.width ? `${image.width}` : '',
        full: image.bytes,
        smallest: image.bytes,
        saving: null,
        quality: null,
        status: '',
      },
      ...formats.map((format) => {
        const list = image.variants
          .filter((variant) => variant.format === format)
          .toSorted((a, b) => a.width - b.width)
        const top = list.at(-1)
        const qualities = [...new Set(list.map((variant) => variant.quality))]
        return {
          format: formatNames[format] ?? format,
          sizes: list
            .map((variant) =>
              variant.density === undefined ? `${variant.width}` : `@${variant.density}x`,
            )
            .join(', '),
          full: top?.bytes ?? null,
          smallest: Math.min(...list.map((variant) => variant.bytes)),
          saving: percentCell(image.bytes, top?.bytes),
          quality: qualities.join('/'),
          status: [
            list.some((variant) => variant.proposed) ? 'proposed' : 'not smaller',
            ...(list.some((variant) => variant.replacesOriginal && variant.proposed)
              ? ['replaces original']
              : []),
            ...(image.best?.format === format ? ['best'] : []),
          ].join(', '),
        }
      }),
    ],
  }
}

function optimizationSection(
  data: AssetsData,
  previous: AssetsData | undefined,
  cards: number,
): Section | undefined {
  const images = data.optimized ?? []
  if (!images.length) return undefined
  const before = new Map(previous?.optimized?.map((image) => [image.path, image]))
  const ok = images.filter((image) => !image.error)
  const changes = (data.changes ?? []).filter((change) => change.id.startsWith('assets:image:'))
  const failed = images.filter((image) => image.error)
  const avif = ok.some((image) => image.variants.some((variant) => variant.format === 'avif'))
  return {
    id: 'optimization',
    title: 'Image optimization',
    description: `Real variants encoded with sharp for the largest images: ${avif ? 'AVIF, ' : ''}WebP and the original format re-encoded, in responsive widths or @1x/@2x densities. Sizes are measured, not estimated.`,
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'path', label: 'Image', format: 'code', path: true },
          { key: 'original', label: 'Original', unit: 'bytes', align: 'end' },
          ...(avif
            ? [{ key: 'avif', label: 'AVIF', unit: 'bytes' as const, align: 'end' as const }]
            : []),
          { key: 'webp', label: 'WebP', unit: 'bytes', align: 'end' },
          { key: 'optimized', label: 'Re-encoded', unit: 'bytes', align: 'end' },
          { key: 'saving', label: 'Best saving', align: 'end' },
          {
            key: 'delta',
            label: 'Δ best',
            unit: 'bytes',
            format: 'delta',
            better: 'down',
            align: 'end',
          },
          { key: 'variants', label: 'Variants', align: 'end' },
          { key: 'usages', label: 'Usages', align: 'end' },
        ],
        rows: ok.map((image) => {
          const was = before.get(image.path)?.best?.bytes
          const own =
            image.format === 'jpg' ? 'jpeg' : image.format === 'apng' ? 'png' : image.format
          return {
            path: image.path,
            original: image.bytes,
            ...(avif ? { avif: fullSize(image, 'avif')?.bytes ?? null } : {}),
            webp: fullSize(image, 'webp')?.bytes ?? null,
            optimized: fullSize(image, own)?.bytes ?? null,
            saving: percentCell(image.bytes, image.best?.bytes),
            delta: was === undefined || image.best === undefined ? null : image.best.bytes - was,
            variants: `${image.variants.filter((variant) => variant.proposed).length}/${image.variants.length}`,
            usages: image.references.length,
          }
        }),
      },
      ...ok.slice(0, cards).map(imageCard),
      ...(failed.length
        ? [
            {
              type: 'issues' as const,
              title: 'Not optimized',
              items: failed.map((image) => ({
                id: `optimize-error:${image.path}`,
                tone: 'warning' as const,
                title: image.path,
                detail: image.error ?? '',
                tags: ['sharp'],
              })),
            },
          ]
        : []),
      ...(changes.length
        ? [
            {
              type: 'changes' as const,
              title: 'Variants and image swaps',
              items: changes.map((change) =>
                changeItem(change, {
                  tags: change.edits.some((edit) => edit.kind === 'replace')
                    ? ['swap', 'variants']
                    : ['variants'],
                }),
              ),
              applicable: true,
            },
          ]
        : []),
    ],
  }
}

const pair = (a: number, b: number) => (a === b ? `${a}` : `${a} → ${b}`)

function svgSection(data: AssetsData, previous: AssetsData | undefined): Section | undefined {
  const svgs = data.svgs ?? []
  if (!svgs.length) return undefined
  const before = new Map(previous?.svgs?.map((svg) => [svg.path, svg]))
  const changes = (data.changes ?? []).filter((change) => change.id.startsWith('assets:svg:'))
  const issues: Issue[] = svgs.flatMap((svg) => [
    ...(svg.error
      ? [
          {
            id: `svg-error:${svg.path}`,
            tone: 'warning' as const,
            title: svg.path,
            detail: svg.error,
            tags: ['svgo'],
          },
        ]
      : []),
    ...svg.breakdown.issues.map((issue) => ({
      id: `svg:${issue.code}:${svg.path}`,
      tone:
        issue.code === 'embedded-raster' || issue.code === 'size-without-viewbox'
          ? ('warning' as const)
          : ('info' as const),
      title: `${svg.path}: ${issue.message}`,
      tags: [issue.code],
    })),
  ])
  const removed = (svg: (typeof svgs)[number]) => {
    const elements = Object.values(svg.breakdown.removedElements).reduce(
      (total, count) => total + count,
      0,
    )
    const attributes = Object.values(svg.breakdown.removedAttributes).reduce(
      (total, count) => total + count,
      0,
    )
    return [
      ...(svg.breakdown.metadata ? [`${svg.breakdown.metadata} metadata`] : []),
      ...(svg.breakdown.comments ? [`${svg.breakdown.comments} comments`] : []),
      ...(elements ? [`${elements} elements`] : []),
      ...(attributes ? [`${attributes} attributes`] : []),
      ...(svg.breakdown.styles.inlineBefore > svg.breakdown.styles.inlineAfter
        ? [`${svg.breakdown.styles.inlineBefore - svg.breakdown.styles.inlineAfter} inline styles`]
        : []),
      ...(svg.breakdown.ids.minified ? [`${svg.breakdown.ids.minified} IDs minified`] : []),
    ].join(', ')
  }
  return {
    id: 'svg',
    title: 'SVG optimization',
    description:
      'Optimized with svgo; the `safe` preset keeps IDs, styles and element types so CSS and scripts keep working.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'path', label: 'SVG', format: 'code', path: true },
          { key: 'preset', label: 'Preset', format: 'tags' },
          { key: 'before', label: 'Before', unit: 'bytes', align: 'end' },
          { key: 'after', label: 'After', unit: 'bytes', align: 'end' },
          { key: 'gzip', label: 'Gzip', align: 'end' },
          { key: 'saving', label: 'Saving', align: 'end' },
          {
            key: 'delta',
            label: 'Δ after',
            unit: 'bytes',
            format: 'delta',
            better: 'down',
            align: 'end',
          },
          { key: 'removed', label: 'Removed' },
        ],
        rows: svgs
          .filter((svg) => !svg.error)
          .map((svg) => {
            const was = before.get(svg.path)?.bytes.after
            return {
              path: svg.path,
              preset: svg.preset,
              before: svg.bytes.before,
              after: svg.bytes.after,
              gzip: `${formatBytes(svg.gzip.before)} → ${formatBytes(svg.gzip.after)}`,
              saving: percentCell(svg.bytes.before, svg.bytes.after),
              delta: was === undefined ? null : svg.bytes.after - was,
              removed: removed(svg),
            }
          }),
      },
      {
        type: 'table',
        title: 'Path data',
        columns: [
          { key: 'path', label: 'SVG', format: 'code', path: true },
          { key: 'paths', label: 'Paths', align: 'end' },
          { key: 'commands', label: 'Commands', align: 'end' },
          { key: 'coordinates', label: 'Coordinates', align: 'end' },
          { key: 'digits', label: 'Digits', align: 'end' },
          { key: 'longest', label: 'Longest path', align: 'end' },
        ],
        rows: svgs
          .filter((svg) => !svg.error && svg.breakdown.paths.before.paths)
          .map((svg) => {
            const { before: from, after: to } = svg.breakdown.paths
            const longest = to.longest[0]
            return {
              path: svg.path,
              paths: pair(from.paths, to.paths),
              commands: pair(from.commands, to.commands),
              coordinates: pair(from.coordinates, to.coordinates),
              digits: pair(from.digits, to.digits),
              longest: longest
                ? `${pair(from.longest[0]?.length ?? 0, longest.length)} chars${longest.id ? ` #${longest.id}` : ''}`
                : null,
            }
          }),
      },
      ...(issues.length
        ? [{ type: 'issues' as const, title: 'viewBox, size and content', items: issues }]
        : []),
      ...(changes.length
        ? [
            {
              type: 'changes' as const,
              title: 'Optimized SVGs',
              items: changes.map((change) =>
                changeItem(change, { tags: ['svgo', change.confidence] }),
              ),
              applicable: true,
            },
          ]
        : []),
    ],
  }
}

const deliveryRules = new Set<string>(['missing-modern-formats', 'single-resolution', 'inline-svg'])

function deliverySection(data: AssetsData): Section | undefined {
  const findings = data.findings.filter((finding) => deliveryRules.has(finding.rule))
  const inline = data.inlineSvgs ?? []
  if (!findings.length && !inline.length) return undefined
  const changes = (data.changes ?? []).filter((change) =>
    change.id.startsWith('assets:inline-svg:'),
  )
  return {
    id: 'delivery',
    title: 'Image delivery',
    description:
      'Rasters without WebP (or, with `avif`, AVIF) versions next to them, large images shipped in a single resolution, and inline SVGs in markup and components that carry editor cruft or excess path precision.',
    blocks: [
      ...(findings.length
        ? [
            {
              type: 'issues' as const,
              items: findings.map((finding) => ({
                id: finding.id,
                tone: finding.tone,
                title: finding.title,
                ...(finding.detail ? { detail: finding.detail } : {}),
                tags: [finding.rule],
              })),
            },
          ]
        : []),
      ...(inline.length
        ? [
            {
              type: 'table' as const,
              title: 'Inline SVGs',
              columns: [
                { key: 'file', label: 'File', format: 'code' as const, path: true },
                { key: 'lines', label: 'Lines', align: 'end' as const },
                { key: 'kind', label: 'Rewrite', format: 'tags' as const },
                { key: 'before', label: 'Before', unit: 'bytes' as const, align: 'end' as const },
                { key: 'after', label: 'After', unit: 'bytes' as const, align: 'end' as const },
                { key: 'saving', label: 'Saving', align: 'end' as const },
                { key: 'digits', label: 'Path digits', align: 'end' as const },
              ],
              rows: inline.map((svg) => ({
                file: svg.file,
                lines: svg.line === svg.endLine ? `${svg.line}` : `${svg.line}–${svg.endLine}`,
                kind: svg.kind === 'svg' ? 'svgo' : 'path data',
                before: svg.bytes.before,
                after: svg.bytes.after,
                saving: percentCell(svg.bytes.before, svg.bytes.after),
                digits: pair(svg.digits.before, svg.digits.after),
              })),
            },
          ]
        : []),
      ...(changes.length
        ? [
            {
              type: 'changes' as const,
              title: 'Optimized inline SVGs',
              items: changes.map((change) =>
                changeItem(change, { tags: ['svgo', change.confidence] }),
              ),
              applicable: true,
            },
          ]
        : []),
    ],
  }
}

function largestSection(data: AssetsData, limit: number): Section {
  const rows: Record<string, Cell>[] = data.assets
    .toSorted((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((asset) => ({
      path: asset.path,
      kind: kindLabels[asset.kind],
      format: asset.format,
      bytes: asset.bytes,
      gzip: asset.gzip ?? null,
      details: detailsOf(asset),
      tags: tagsOf(asset),
    }))
  return {
    id: 'largest',
    title: 'Largest assets',
    blocks: [
      rows.length === 0
        ? { type: 'markdown', text: 'No assets found under the scanned roots.' }
        : {
            type: 'table',
            columns: [
              { key: 'path', label: 'Asset', format: 'code', path: true },
              { key: 'kind', label: 'Kind' },
              { key: 'format', label: 'Format', format: 'code' },
              { key: 'bytes', label: 'Size', unit: 'bytes', align: 'end' },
              { key: 'gzip', label: 'Gzip', unit: 'bytes', align: 'end' },
              { key: 'details', label: 'Details' },
              { key: 'tags', label: 'Tags', format: 'tags' },
            ],
            rows,
          },
    ],
  }
}

function changesSection(comparison: AssetComparison): Section {
  return {
    id: 'changes',
    title: 'Changes since previous',
    description: 'Assets match by path; a new path with the content of a removed one is a rename.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'kind', label: 'Kind' },
          { key: 'previous', label: 'Previous', unit: 'bytes', align: 'end' },
          { key: 'current', label: 'Current', unit: 'bytes', align: 'end' },
          {
            key: 'delta',
            label: 'Δ',
            unit: 'bytes',
            format: 'delta',
            better: 'down',
            align: 'end',
          },
          { key: 'files', label: 'Files', align: 'end' },
        ],
        rows: comparison.kinds.map((kind) => ({
          kind: kindLabels[kind.kind],
          previous: kind.previous,
          current: kind.current,
          delta: kind.delta,
          files:
            kind.previousCount === kind.currentCount
              ? `${kind.currentCount}`
              : `${kind.previousCount} → ${kind.currentCount}`,
        })),
      },
      comparison.assets.length
        ? {
            type: 'table',
            title: 'Assets',
            columns: [
              { key: 'path', label: 'Asset', format: 'code', path: true },
              { key: 'status', label: 'Status', format: 'tags' },
              { key: 'previous', label: 'Previous', unit: 'bytes', align: 'end' },
              { key: 'current', label: 'Current', unit: 'bytes', align: 'end' },
              {
                key: 'delta',
                label: 'Δ',
                unit: 'bytes',
                format: 'delta',
                better: 'down',
                align: 'end',
              },
            ],
            rows: comparison.assets.map((change) => ({
              path: change.previousPath ? `${change.previousPath} → ${change.path}` : change.path,
              status: change.status,
              previous: change.previousBytes ?? null,
              current: change.bytes ?? null,
              delta: change.delta,
            })),
          }
        : { type: 'markdown', text: 'No asset changed.' },
    ],
  }
}

function duplicatesSection(data: AssetsData): Section {
  return {
    id: 'duplicates',
    title: 'Duplicates',
    description: 'Files with identical content. Keeping one copy saves the rest.',
    blocks: [
      data.duplicates.length
        ? {
            type: 'table',
            columns: [
              { key: 'paths', label: 'Files', format: 'tags' },
              { key: 'copies', label: 'Copies', align: 'end' },
              { key: 'bytes', label: 'Size each', unit: 'bytes', align: 'end' },
              { key: 'wasted', label: 'Wasted', unit: 'bytes', align: 'end' },
            ],
            rows: data.duplicates.map((group) => ({
              paths: group.paths.join(', '),
              copies: group.paths.length,
              bytes: group.bytes,
              wasted: wasted(group),
            })),
          }
        : { type: 'markdown', text: 'No duplicate files.' },
    ],
  }
}

const assetsExclude: ReportExclude = {
  setting: 'analyzers.assets',
  options: [
    {
      option: 'optimizeIgnore',
      label: 'Skip optimization',
      description: 'Still counted in totals and budgets, never flagged, converted or optimized',
    },
    {
      option: 'ignore',
      label: 'Ignore entirely',
      description: 'Left out of the inventory, totals, budgets and every check',
    },
  ],
}

/** The `assets` analysis kind with custom display settings. */
export function createAssetsAnalysis(
  options: AssetsAnalysisOptions = {},
): AnalysisKind<AssetsData> {
  const largest = options.largest ?? 25
  const treemapFiles = options.treemapFiles ?? 40
  const imageCards = options.imageCards ?? 10
  return defineAnalysis<AssetsData>({
    kind: 'assets',
    label: 'Asset budgets',
    schema: assetsDataSchema,
    summarize: (data) => metricsOf(data),
    changes: (data) => data.changes ?? [],
    toReport(current, previous): Report {
      const data = current.data
      const before = previous?.data
      const comparison = before ? compareAssets(before, data) : undefined
      return {
        kind: 'assets',
        title: 'Asset budgets',
        ...(current.ref ? { subtitle: current.ref } : {}),
        subject: {
          repo: current.repo,
          ...(current.ref ? { ref: current.ref } : {}),
          ...(previous?.ref ? { compareTo: previous.ref } : {}),
        },
        generatedAt: new Date().toISOString(),
        metrics: metricsOf(data, before),
        exclude: assetsExclude,
        sections: [
          overview(data, before, treemapFiles),
          budgetsSection(data, before, comparison),
          suggestionsSection(data),
          ...[
            optimizationSection(data, before, imageCards),
            svgSection(data, before),
            deliverySection(data),
          ].filter((section): section is Section => section !== undefined),
          largestSection(data, largest),
          ...(comparison ? [changesSection(comparison)] : []),
          duplicatesSection(data),
        ],
      }
    },
  })
}

/** Images, audio, fonts and other shipped files against budgets, compared with the previous record. */
export const assetsAnalysis: AnalysisKind<AssetsData> = createAssetsAnalysis()
