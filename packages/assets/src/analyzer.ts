import { type AnalyzerArtifact, defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { assetsAnalysis } from './analysis.ts'
import { analyzeAssets, collectArtifacts } from './analyze.ts'
import { type AssetsData, budgetSchema, totalBudgetsSchema } from './data.ts'

const contentTypes: Record<string, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}

/** The run's encoded variants as analyzer artifacts, with content type and target path. */
export function runArtifacts(data: AssetsData): AnalyzerArtifact[] {
  const variants = new Map(
    (data.optimized ?? []).flatMap((image) =>
      image.variants.map((variant) => [variant.sha256, variant]),
    ),
  )
  return collectArtifacts(data).map((artifact) => {
    const variant = variants.get(artifact.sha256)
    return {
      id: artifact.sha256,
      data: artifact.data,
      ...(variant ? { contentType: contentTypes[variant.format], name: variant.file } : {}),
    }
  })
}

/** Options of the `assets` analyzer, from config or flags. */
export const assetsOptionsSchema = z.object({
  /** Globs to scan; default `defaultRoots`. */
  roots: z.array(z.string()).optional(),
  /** Build output folder to scan as well, e.g. `dist`. */
  dist: z.string().optional(),
  /** Globs of files left out entirely. */
  ignore: z.array(z.string()).default([]),
  /** Globs of files still counted in totals and budgets but never flagged or optimized. */
  optimizeIgnore: z.array(z.string()).default([]),
  budgets: z.array(budgetSchema).default([]),
  /** Maximum total bytes per kind, e.g. `{ audio: 5000000 }`. */
  total: totalBudgetsSchema.default({}),
  /** Default `sharp` when sharp loads on the runner, else `estimate`. */
  convert: z.enum(['sharp', 'estimate', 'tools', 'off']).optional(),
  /** With `sharp`: how many images (largest first) get real variants. */
  optimizeTop: z.coerce.number().int().nonnegative().default(20),
  /** With `sharp`: svgo preset of SVG changes. */
  svgPreset: z.enum(['safe', 'default', 'aggressive']).default('safe'),
  /** With `sharp`: variant file name templates. */
  naming: z.object({ width: z.string().optional(), density: z.string().optional() }).optional(),
  /** Check inline `<svg>`/`<path>` elements of markup and components. */
  inlineSvg: z.coerce.boolean().default(true),
})

export type AssetsOptions = z.infer<typeof assetsOptionsSchema>

/**
 * Inventories shipped assets of a checkout and checks them against budgets. With `convert:
 * 'sharp'` the returned data carries proposed changes whose binary variants are available through
 * `collectArtifacts(data)` until the data is serialized.
 */
export const assetsAnalyzer = defineAnalyzer<AssetsData, AssetsOptions>({
  kind: 'assets',
  analysis: assetsAnalysis,
  scope: 'repo',
  needs: { checkout: true },
  options: assetsOptionsSchema,
  flags: [
    { flag: 'dist', option: 'dist', description: 'build output folder to include, e.g. dist' },
    {
      flag: 'convert',
      option: 'convert',
      description:
        'sharp (default when available: real variants and changes), estimate, tools (cwebp/avifenc/ffmpeg/woff2_compress) or off',
    },
    {
      flag: 'optimize-top',
      option: 'optimizeTop',
      description: 'images optimized with sharp, largest first (default 20)',
    },
    {
      flag: 'inline-svg',
      option: 'inlineSvg',
      description: 'check inline <svg>/<path> in markup and components (default true)',
      type: 'boolean',
    },
    {
      flag: 'svg-preset',
      option: 'svgPreset',
      description: 'svgo preset: safe (default), default or aggressive',
    },
  ],
  async run({ dir, ref, runner, cache, options, signal, log }) {
    if (!dir) throw new Error('the assets analyzer needs a checkout')
    const data = await analyzeAssets({
      dir,
      ...(options.roots ? { roots: options.roots } : {}),
      ...(options.dist ? { dist: options.dist } : {}),
      ignore: options.ignore,
      optimizeIgnore: options.optimizeIgnore,
      budgets: options.budgets,
      total: options.total,
      ...(options.convert ? { convert: options.convert } : {}),
      optimizeTop: options.optimizeTop,
      svgPreset: options.svgPreset,
      ...(options.naming ? { naming: options.naming } : {}),
      inlineSvg: options.inlineSvg,
      ...(cache ? { cache } : {}),
      runner,
      ...(signal ? { signal } : {}),
      ...(log ? { log } : {}),
    })
    const artifacts = runArtifacts(data)
    return { data, ...(ref ? { ref } : {}), ...(artifacts.length ? { artifacts } : {}) }
  },
})
