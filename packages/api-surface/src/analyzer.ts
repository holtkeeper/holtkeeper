import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { extractApi } from './extract.ts'
import type { ApiSurfaceData } from './model.ts'
import { apiSurfaceAnalysis } from './report.ts'

const list = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : value,
  z.array(z.string().min(1)).default([]),
)

/** Options of the `api-surface` analyzer. */
export const apiSurfaceOptionsSchema = z.object({
  /** Glob patterns of package names to keep, e.g. `@acme/*`; every package when empty. */
  packages: list,
  /** Glob patterns of package folders to skip, e.g. `examples/*`; a comma-separated string works too. */
  exclude: list,
  /** Include packages marked `"private": true`, e.g. the apps of a monorepo. */
  includePrivate: z.boolean().default(true),
})

export type ApiSurfaceOptions = z.output<typeof apiSurfaceOptionsSchema>

/**
 * The `api-surface` analyzer: reads the public API of every package in a checkout (exports with
 * declarations and doc comments) without installing or building anything. Run on release tags it
 * keeps one record per version, which the server serves to agents and diffs between versions.
 */
export const apiSurfaceAnalyzer = defineAnalyzer<ApiSurfaceData, ApiSurfaceOptions>({
  kind: 'api-surface',
  analysis: apiSurfaceAnalysis,
  scope: 'repo',
  needs: { checkout: true },
  options: apiSurfaceOptionsSchema,
  flags: [
    { flag: 'packages', option: 'packages', description: 'comma-separated package name globs' },
    { flag: 'exclude', option: 'exclude', description: 'comma-separated package folder globs' },
  ],
  async run({ dir, ref, options, log }) {
    if (!dir) throw new Error('the api-surface analyzer needs a checkout')
    const packages = await extractApi({
      dir,
      packages: options.packages,
      exclude: options.exclude,
      includePrivate: options.includePrivate,
    })
    log?.(`api-surface: ${packages.length} package(s)`)
    return { data: { packages }, ...(ref ? { ref } : {}) }
  },
})
