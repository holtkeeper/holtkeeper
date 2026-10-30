import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { analyzeLicenses } from './analyze.ts'
import { defaultAllow, defaultDeny, type LicensesData } from './model.ts'
import { licensesAnalysis } from './report.ts'

/** A list option that also accepts a comma-separated string, as flags pass it. */
const list = (fallback: readonly string[]) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : value,
    z.array(z.string().min(1)).default([...fallback]),
  )

/** Options of the `licenses` analyzer. */
export const licensesOptionsSchema = z.object({
  /** SPDX ids, `*` patterns or whole expressions that are acceptable. */
  allow: list(defaultAllow),
  /** SPDX ids, `*` patterns or expressions that are never acceptable; they win over `allow`. */
  deny: list(defaultDeny),
  /** Package names (`*` wildcards allowed) to leave out of the verdict. */
  ignore: list([]),
})

export type LicensesOptions = z.output<typeof licensesOptionsSchema>

/**
 * The `licenses` analyzer: lists third-party packages of a checkout with their licenses through
 * osv-scanner and judges them against the allow and deny lists.
 */
export const licensesAnalyzer = defineAnalyzer<LicensesData, LicensesOptions>({
  kind: 'licenses',
  analysis: licensesAnalysis,
  scope: 'repo',
  needs: { checkout: true },
  options: licensesOptionsSchema,
  flags: [
    {
      flag: 'allow',
      option: 'allow',
      description: 'comma-separated SPDX ids or expressions to allow',
    },
    {
      flag: 'deny',
      option: 'deny',
      description: 'comma-separated SPDX ids or patterns to deny (default GPL-*,AGPL-*,SSPL-*)',
    },
    { flag: 'ignore', option: 'ignore', description: 'comma-separated package names to skip' },
  ],
  async run({ dir, ref, runner, options, signal }) {
    if (!dir) throw new Error('the licenses analyzer needs a checkout')
    const data = await analyzeLicenses({
      dir,
      runner,
      policy: options,
      ...(signal ? { signal } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})
