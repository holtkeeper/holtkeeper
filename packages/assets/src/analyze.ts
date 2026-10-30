import type { CommandRunner } from '@holtkeeper/exec'
import { type Artifact, type NamingScheme, type SvgPreset, sharpAvailable } from '@holtkeeper/media'

import { evaluateBudgets, totalsOf } from './budgets.ts'
import type { Asset, AssetsData, Budget, Suggestion, TotalBudgets } from './data.ts'
import { detectEngines } from './engine.ts'
import { findDuplicates, findIssues } from './findings.ts'
import { defaultRoots, inventory } from './inventory.ts'
import { optimizableFormats, optimizeAssets } from './optimize.ts'
import { collectTokens, markReferences } from './references.ts'
import { candidates, estimateSuggestions, measureSuggestions } from './suggest.ts'
import { findReferences, usageSources } from './usages.ts'

export interface AnalyzeAssetsOptions {
  /** Repository checkout. */
  dir: string
  /** Globs relative to `dir`. Default `defaultRoots`. */
  roots?: string[]
  /** Build output folder relative to `dir`; its files are inventoried as `origin: 'build'`. */
  dist?: string
  ignore?: string[]
  budgets?: Budget[]
  total?: TotalBudgets
  /**
   * `sharp` encodes real variants in-process and proposes changes, `tools` measures savings with
   * installed converters, `estimate` uses ratios, `off` skips. Default `sharp` when sharp loads,
   * else `estimate`; an explicit `sharp` without sharp falls back to `estimate`.
   */
  convert?: 'sharp' | 'estimate' | 'tools' | 'off'
  /** With `sharp`: images (raster and SVG) optimized, largest first. Default 20. */
  optimizeTop?: number
  /** With `sharp`: svgo preset for SVG changes. Default `safe`. */
  svgPreset?: SvgPreset
  /** With `sharp`: variant file names. Default `{name}-{width}w.{ext}` / `{name}@{density}x.{ext}`. */
  naming?: NamingScheme
  /** Required for `convert: 'tools'`. */
  runner?: CommandRunner
  /** Assets below this size get no conversion suggestion. Default 8 kB. */
  minBytes?: number
  /** Suggestions saving less are dropped. Default 2 kB. */
  minSaving?: number
  /** Search source files for asset names. Default true. */
  references?: boolean
  signal?: AbortSignal
  log?: (line: string) => void
}

const runArtifacts = new WeakMap<AssetsData, Artifact[]>()

/**
 * Binary files the run that produced `data` encoded, referenced by the `artifact` (SHA-256) of
 * its `write-binary` edits. Only the object `analyzeAssets` returned has them, in the same process;
 * a copy, a parsed record or a run without `convert: 'sharp'` gives an empty list. Runners persist
 * them (keyed by `sha256`) before the data is serialized, so changes can be applied later.
 */
export function collectArtifacts(data: AssetsData): Artifact[] {
  return runArtifacts.get(data) ?? []
}

/** Images worth optimizing with sharp: source rasters and SVGs above `minBytes`, largest first, at most `top`. */
export function optimizationCandidates(
  assets: readonly Asset[],
  minBytes: number,
  top: number,
): Asset[] {
  return assets
    .filter(
      (asset) =>
        asset.origin === 'source' &&
        asset.kind === 'image' &&
        (asset.format === 'svg'
          ? asset.bytes >= Math.min(minBytes, 512)
          : asset.bytes >= minBytes) &&
        (asset.format === 'svg' || optimizableFormats.has(asset.format)),
    )
    .toSorted((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, top))
}

/** Inventories, checks and suggests in one pass; never writes to `dir`. */
export async function analyzeAssets(options: AnalyzeAssetsOptions): Promise<AssetsData> {
  const roots = options.roots?.length ? options.roots : defaultRoots
  const dist = options.dist?.replace(/^\.?\/+|\/+$/g, '')
  const buildRoots = dist ? [`${dist}/**`] : []
  let convert = options.convert ?? ((await sharpAvailable()) ? 'sharp' : 'estimate')
  if (convert === 'sharp' && !(await sharpAvailable())) {
    options.log?.('assets: sharp is not available, estimating instead')
    convert = 'estimate'
  }
  const scanned = await inventory({
    dir: options.dir,
    roots,
    buildRoots,
    ...(options.ignore ? { ignore: options.ignore } : {}),
  })
  options.log?.(`assets: ${scanned.length} files under ${[...roots, ...buildRoots].join(', ')}`)
  let assets = scanned.map((item) => item.asset)
  if (options.references !== false) {
    const extra = scanned.flatMap((item) => (item.text === undefined ? [] : [item.text]))
    assets = markReferences(assets, await collectTokens(options.dir, extra, options.ignore))
  }
  const engines = await detectEngines(options.dir)
  const list = convert === 'off' ? [] : candidates(assets, options.minBytes ?? 8 * 1024)
  const minSaving = options.minSaving ?? 2 * 1024
  let suggestions = estimateSuggestions(list, minSaving)
  let tools: string[] = []
  if (convert === 'tools') {
    if (!options.runner) throw new Error("convert: 'tools' needs a command runner")
    const measured = await measureSuggestions(list, {
      dir: options.dir,
      runner: options.runner,
      minSaving,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    suggestions = measured.suggestions
    tools = measured.tools
  }
  let optimized: Pick<AssetsData, 'optimized' | 'svgs' | 'changes'> = {}
  let artifacts: Artifact[] = []
  if (convert === 'sharp') {
    const chosen = optimizationCandidates(
      assets,
      options.minBytes ?? 8 * 1024,
      options.optimizeTop ?? 20,
    )
    const sources = await usageSources(options.dir, options.ignore)
    const result = await optimizeAssets({
      dir: options.dir,
      rasters: chosen.filter((asset) => asset.format !== 'svg'),
      svgs: chosen.filter((asset) => asset.format === 'svg'),
      references: findReferences(sources, new Set(chosen.map((asset) => asset.path))),
      sources,
      engines,
      minSaving,
      svgPreset: options.svgPreset ?? 'safe',
      ...(options.naming ? { naming: options.naming } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.log ? { log: options.log } : {}),
    })
    optimized = { optimized: result.images, svgs: result.svgs, changes: result.changes }
    artifacts = result.artifacts
    suggestions = mergeMeasured(suggestions, result.images, result.svgs, assets, minSaving)
    tools = [
      ...(result.images.some((image) => image.best) ? ['sharp'] : []),
      ...(result.svgs.some((svg) => !svg.error) ? ['svgo'] : []),
    ]
  }
  const data: AssetsData = {
    roots: [...roots, ...buildRoots],
    engines,
    convert,
    tools,
    assets,
    totals: totalsOf(assets),
    budgets: evaluateBudgets(assets, options.budgets ?? [], options.total ?? {}),
    findings: findIssues(assets, { engines }),
    suggestions,
    duplicates: findDuplicates(assets),
    ...optimized,
  }
  runArtifacts.set(data, artifacts)
  return data
}

const formatLabels: Record<string, string> = {
  avif: 'AVIF',
  webp: 'WebP',
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
}

/** Estimated image suggestions replaced by what sharp and svgo measured. */
function mergeMeasured(
  suggestions: Suggestion[],
  images: AssetsData['optimized'] & {},
  svgs: AssetsData['svgs'] & {},
  assets: readonly Asset[],
  minSaving: number,
): Suggestion[] {
  const measured = new Set([...images.map((image) => image.path), ...svgs.map((svg) => svg.path)])
  const byPath = new Map(assets.map((asset) => [asset.path, asset]))
  const kept = suggestions.filter((suggestion) => !measured.has(suggestion.path))
  for (const image of images) {
    const previous = suggestions.find((suggestion) => suggestion.path === image.path)
    if (image.error || !image.best) {
      if (previous) kept.push(previous)
      continue
    }
    if (image.best.saving < minSaving) continue
    const variant = image.variants.find(
      (entry) => entry.format === image.best?.format && entry.bytes === image.best.bytes,
    )
    kept.push({
      id: `${previous?.rule ?? 'opaque-png'}:${image.path}`,
      rule:
        previous?.rule ??
        (byPath.get(image.path)?.image?.alpha
          ? 'alpha-png'
          : image.format === 'gif'
            ? 'animated-gif'
            : image.format.startsWith('jp')
              ? 'jpeg'
              : 'opaque-png'),
      path: image.path,
      kind: 'image',
      format: image.format,
      bytes: image.bytes,
      suggested: image.best.format,
      how: `sharp ${formatLabels[image.best.format] ?? image.best.format}${variant ? ` q${variant.quality}` : ''}, ${image.variants.filter((entry) => entry.proposed).length} variants`,
      expectedBytes: image.best.bytes,
      method: 'measured',
      saving: image.best.saving,
    })
  }
  for (const svg of svgs) {
    const saving = svg.bytes.before - svg.bytes.after
    if (svg.error || saving <= 0 || !svg.changeId) continue
    kept.push({
      id: `svg:${svg.path}`,
      rule: 'svg',
      path: svg.path,
      kind: 'image',
      format: 'svg',
      bytes: svg.bytes.before,
      suggested: 'svg',
      how: `svgo (${svg.preset} preset)`,
      expectedBytes: svg.bytes.after,
      method: 'measured',
      saving,
    })
  }
  return kept.toSorted((a, b) => b.saving - a.saving || a.path.localeCompare(b.path))
}
