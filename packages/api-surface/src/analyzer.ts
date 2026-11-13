import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { apiSurfaceApplies } from './applies.ts'
import { extractApi } from './extract.ts'
import { extractGoApi, goModuleVersions, tagsAtHead } from './go.ts'
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
  /** Include Go packages under `internal/` (as private), for agents working inside the repository. */
  includeInternal: z.boolean().default(true),
})

export type ApiSurfaceOptions = z.output<typeof apiSurfaceOptionsSchema>

/**
 * The `api-surface` analyzer: reads the public API of every npm package and Go package in a
 * checkout (exports with declarations and doc comments) without installing or building anything.
 * Run on release tags it keeps one record per version, which the server serves to agents and diffs
 * between versions. Go packages get the version of the module tag pointing at the analyzed commit.
 */
export const apiSurfaceAnalyzer = defineAnalyzer<ApiSurfaceData, ApiSurfaceOptions>({
  kind: 'api-surface',
  analysis: apiSurfaceAnalysis,
  scope: 'repo',
  refresh: { on: 'change', minInterval: '6h' },
  needs: { checkout: true },
  appliesTo: apiSurfaceApplies,
  options: apiSurfaceOptionsSchema,
  flags: [
    { flag: 'packages', option: 'packages', description: 'comma-separated package name globs' },
    { flag: 'exclude', option: 'exclude', description: 'comma-separated package folder globs' },
  ],
  async run({ dir, ref, options, runner, log, signal }) {
    if (!dir) throw new Error('the api-surface analyzer needs a checkout')
    const npm = await extractApi({
      dir,
      packages: options.packages,
      exclude: options.exclude,
      includePrivate: options.includePrivate,
    })
    const go = await extractGoApi({
      dir,
      packages: options.packages,
      exclude: options.exclude,
      includeInternal: options.includeInternal,
      resolveVersions: async (modules) =>
        goModuleVersions(await tagsAtHead(runner, dir, log, signal), modules, ref),
    })
    const packages = [...npm, ...go.packages]
    log?.(
      `api-surface: ${npm.length} npm package(s), ${go.packages.length} Go package(s) in ${go.modules.length} Go module(s)`,
    )
    for (const module of go.modules)
      log?.(
        `api-surface: Go module ${module.path} (${module.dir})${module.version ? ` ${module.version}` : ''}: ${module.packages} importable, ${module.internalPackages} internal, ${module.mainPackages} main package(s)`,
      )
    return {
      data: { packages, ...(go.modules.length ? { go: { modules: go.modules } } : {}) },
      ...(ref ? { ref } : {}),
    }
  },
})
