import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { analyzeCoverage } from './analyze.ts'
import type { CoverageData } from './model.ts'
import { DEFAULT_COVERAGE_TARGET, coverageAnalysis, coverageTargetSchema } from './report.ts'

/** Options of the `coverage` analyzer. */
const list = (value: unknown) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : value

export const coverageOptionsSchema = z.object({
  /** lcov tracefile or Go cover profile in the checkout to read instead of running the tests. */
  file: z.string().min(1).optional(),
  /** Glob patterns of files to leave out, e.g. `src/generated/**`; a comma-separated string works too. */
  exclude: z.preprocess(list, z.array(z.string().min(1)).default([])),
  /** Count source files no test loaded as uncovered. */
  untested: z.boolean().default(true),
  /** Count component files (`.tsx`, `.jsx`) too; by default components need no tests. */
  components: z.boolean().default(false),
  /** Install JavaScript dependencies from the lockfile when `node_modules` is missing. */
  install: z.boolean().default(true),
  /** Let that install run lifecycle scripts such as `postinstall`. */
  installScripts: z.boolean().default(false),
  /** Build workspace packages whose entry files are missing before running the tests. */
  build: z.boolean().default(true),
  /**
   * Go build tags of a second `go test` run whose coverage is added to the untagged run's, e.g.
   * `integration`; a comma-separated string works too. None by default.
   */
  goTags: z.preprocess(list, z.array(z.string().regex(/^[\w.]+$/)).default([])),
  /** Go's `-timeout` for each test binary, a Go duration such as `5m` or `90s`. */
  goTestTimeout: z
    .string()
    .regex(/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/)
    .default('5m'),
  /** Line coverage the repository should reach, in percent; stored metrics and health judge by it. */
  target: coverageTargetSchema.default(DEFAULT_COVERAGE_TARGET),
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
  refresh: { on: 'change', minInterval: '1d', heavy: true },
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
      flag: 'go-tags',
      option: 'goTags',
      description: 'comma-separated Go build tags of a second test run',
    },
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
      components: options.components,
      install: options.install,
      installScripts: options.installScripts,
      build: options.build,
      go: { tags: options.goTags, testTimeout: options.goTestTimeout },
      ...(log ? { log } : {}),
      ...(options.file ? { file: options.file } : {}),
      ...(signal ? { signal } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})
