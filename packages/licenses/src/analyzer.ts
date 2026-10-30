import { type AnalyzerPreset, defineAnalyzer } from '@holtkeeper/analyzer'
import { loadPackageCatalog } from '@holtkeeper/depgraph'
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
  /** `violation` judges packages without a recognizable license not allowed instead of warning. */
  unknown: z.enum(['warn', 'violation']).default('warn'),
  /** Warn when the repository itself carries no license file at its root. */
  requireProjectLicense: z.boolean().default(false),
})

export type LicensesOptions = z.output<typeof licensesOptionsSchema>

/** Weak (file- or library-level) copyleft: fine to depend on unmodified in most products. */
const weakCopyleft = ['LGPL-*', 'MPL-*', 'EPL-*', 'CDDL-*']

/** Not open source: forbid use in production or as a service. */
const sourceAvailable = [
  'SSPL-*',
  'BUSL-*',
  'Elastic-*',
  'Commons-Clause',
  'CC-BY-NC-*',
  'CC-BY-NC-SA-*',
]

/** License policies for typical projects; each sets `allow`, `deny` and `unknown` together. */
export const licensePresets: AnalyzerPreset<LicensesOptions>[] = [
  {
    id: 'commercial',
    label: 'Commercial product',
    description:
      'Shipped to customers: permissive licenses pass, strong copyleft and source-available licenses are denied, weak copyleft is flagged for review.',
    options: {
      allow: [...defaultAllow],
      deny: ['GPL-*', 'AGPL-*', ...sourceAvailable],
      unknown: 'warn',
    },
  },
  {
    id: 'no-copyleft',
    label: 'No copyleft',
    description:
      'Only permissive licenses pass; any copyleft is denied and packages without a recognizable license count as violations.',
    options: {
      allow: [...defaultAllow],
      deny: [
        'GPL-*',
        'AGPL-*',
        'LGPL-*',
        ...weakCopyleft,
        'EUPL-*',
        'OSL-*',
        'CPL-*',
        'CC-BY-SA-*',
        ...sourceAvailable,
      ],
      unknown: 'violation',
    },
  },
  {
    id: 'open-source',
    label: 'Open-source project',
    description:
      'Published under a free license: copyleft is fine, source-available and non-commercial licenses are denied, and the repository must carry its own license file.',
    options: {
      allow: [...defaultAllow, ...weakCopyleft, 'GPL-*', 'AGPL-*', 'EUPL-*', 'CC-BY-SA-*'],
      deny: sourceAvailable,
      unknown: 'warn',
      requireProjectLicense: true,
    },
  },
  {
    id: 'internal',
    label: 'Private / internal',
    description:
      'Never distributed outside the company: GPL and weak copyleft pass, AGPL (network use) and source-available licenses are denied.',
    options: {
      allow: [...defaultAllow, ...weakCopyleft, 'GPL-*'],
      deny: ['AGPL-*', ...sourceAvailable],
      unknown: 'warn',
    },
  },
  {
    id: 'flag-missing',
    label: 'Flag missing licenses',
    description:
      'Keeps the allow and deny lists; packages without a recognizable license count as violations and the repository must carry a license file.',
    options: { unknown: 'violation', requireProjectLicense: true },
  },
]

/**
 * The `licenses` analyzer: lists third-party packages of a checkout with their licenses through
 * osv-scanner and judges them against the allow and deny lists. Packages that analyzed
 * repositories define (their newest `depgraph` records in history) are `internal` instead.
 */
export const licensesAnalyzer = defineAnalyzer<LicensesData, LicensesOptions>({
  kind: 'licenses',
  analysis: licensesAnalysis,
  scope: 'repo',
  needs: { checkout: true, history: true },
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
    {
      flag: 'unknown',
      option: 'unknown',
      description: 'warn (default) or violation for packages without a recognizable license',
    },
    {
      flag: 'require-project-license',
      option: 'requireProjectLicense',
      description: 'warn when the repository has no license file',
      type: 'boolean',
    },
  ],
  presets: licensePresets,
  async run({ dir, ref, runner, options, history, signal }) {
    if (!dir) throw new Error('the licenses analyzer needs a checkout')
    const catalog = history ? await loadPackageCatalog(history.analyses) : undefined
    const data = await analyzeLicenses({
      dir,
      runner,
      policy: options,
      ...(catalog && {
        internal: (ecosystem: string, name: string) => {
          const found = catalog.find(ecosystem, name)
          return found && `${found.repo.forge}:${found.repo.path}`
        },
      }),
      ...(signal ? { signal } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})
