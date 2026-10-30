import { defineAnalyzer } from '@holtkeeper/analyzer'
import { installDependencies } from '@holtkeeper/coverage'
import { z } from 'zod'

import { extractUsages } from './extract.ts'
import type { UsagesData } from './model.ts'
import { usagesAnalysis } from './report.ts'

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

/** Options of the `usages` analyzer. */
export const usagesOptionsSchema = z.object({
  /** Glob patterns of package names to keep, e.g. `@acme/*`; every imported dependency when empty. */
  packages: list,
  /** Glob patterns of files to skip, e.g. `**\/*.stories.tsx`; a comma-separated string works too. */
  exclude: list,
  /**
   * Resolve names with the TypeScript checker: `auto` when a `tsconfig.json` and installed
   * dependencies exist (after `install`), `off` to follow imports only.
   */
  types: z.enum(['auto', 'off']).default('auto'),
  /** Install dependencies from the lockfile, without lifecycle scripts, so the checker sees them. */
  install: z.boolean().default(true),
})

export type UsagesOptions = z.output<typeof usagesOptionsSchema>

/**
 * The `usages` analyzer: reads which exports, members and JSX props of its dependencies a
 * repository's code uses and where, with snippets. Run on the default branch it keeps the fleet's
 * "used by" index current for people and for agents planning migrations.
 */
export const usagesAnalyzer = defineAnalyzer<UsagesData, UsagesOptions>({
  kind: 'usages',
  analysis: usagesAnalysis,
  scope: 'repo',
  needs: { checkout: true },
  options: usagesOptionsSchema,
  flags: [
    { flag: 'packages', option: 'packages', description: 'comma-separated package name globs' },
    { flag: 'exclude', option: 'exclude', description: 'comma-separated file globs to skip' },
    { flag: 'types', option: 'types', description: 'auto (default) or off' },
  ],
  async run({ dir, ref, options, runner, signal, log }) {
    if (!dir) throw new Error('the usages analyzer needs a checkout')
    if (options.types === 'auto' && options.install) {
      const install = await installDependencies({ dir, runner, ...(signal ? { signal } : {}) })
      log?.(
        install.status === 'skipped'
          ? `usages: dependencies not installed (${install.reason})`
          : `usages: ${install.command.join(' ')} ${install.status === 'installed' ? 'ok' : `failed\n${install.error}`}`,
      )
    }
    const data = await extractUsages({
      dir,
      packages: options.packages,
      exclude: options.exclude,
      types: options.types === 'auto',
      ...(signal ? { signal } : {}),
      ...(log ? { log } : {}),
    })
    log?.(`usages: ${data.packages.length} package(s)`)
    return { data, ...(ref ? { ref } : {}) }
  },
})
