import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { analyzeCoverage } from './analyze.ts'
import type { CoverageData } from './model.ts'
import { coverageAnalysis } from './report.ts'

/** Options of the `coverage` analyzer. */
export const coverageOptionsSchema = z.object({
  /** lcov tracefile or Go cover profile in the checkout to read instead of running the tests. */
  file: z.string().min(1).optional(),
  /** Glob patterns of files to leave out, e.g. `src/generated/**`; a comma-separated string works too. */
  exclude: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : value,
    z.array(z.string().min(1)).default([]),
  ),
  /** Count source files no test loaded as uncovered. */
  untested: z.boolean().default(true),
  /** Install JavaScript dependencies from the lockfile when `node_modules` is missing. */
  install: z.boolean().default(true),
  /** Let that install run lifecycle scripts such as `postinstall`. */
  installScripts: z.boolean().default(false),
  /** Build workspace packages whose entry files are missing before running the tests. */
  build: z.boolean().default(true),
})

export type CoverageOptions = z.output<typeof coverageOptionsSchema>

/**
 * The `coverage` analyzer: runs a checkout's tests with coverage for every detected framework (or
 * reads an existing report) and records coverage per source file.
 */
export const coverageAnalyzer = defineAnalyzer<CoverageData, CoverageOptions>({
  kind: 'coverage',
  analysis: coverageAnalysis,
  scope: 'repo',
  needs: { checkout: true },
  options: coverageOptionsSchema,
  flags: [
    {
      flag: 'file',
      option: 'file',
      description: 'read this lcov or Go cover profile instead of running tests',
    },
    { flag: 'exclude', option: 'exclude', description: 'comma-separated globs of files to skip' },
    {
      flag: 'install-scripts',
      option: 'installScripts',
      description: 'run lifecycle scripts while installing dependencies',
      type: 'boolean',
    },
  ],
  async run({ dir, ref, runner, options, signal, log }) {
    if (!dir) throw new Error('the coverage analyzer needs a checkout')
    const data = await analyzeCoverage({
      dir,
      runner,
      exclude: options.exclude,
      untested: options.untested,
      install: options.install,
      installScripts: options.installScripts,
      build: options.build,
      ...(log ? { log } : {}),
      ...(options.file ? { file: options.file } : {}),
      ...(signal ? { signal } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})
