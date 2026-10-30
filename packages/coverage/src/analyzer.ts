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
  ],
  async run({ dir, ref, runner, options, signal }) {
    if (!dir) throw new Error('the coverage analyzer needs a checkout')
    const data = await analyzeCoverage({
      dir,
      runner,
      exclude: options.exclude,
      untested: options.untested,
      ...(options.file ? { file: options.file } : {}),
      ...(signal ? { signal } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})
