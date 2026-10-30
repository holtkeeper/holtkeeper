import { z } from 'zod'

import type { LicenseVerdict } from './spdx.ts'

/**
 * Verdict of one package: a license verdict, `ignored` when the policy ignores the package, or
 * `internal` when one of the analyzed repositories defines it.
 */
export type PackageVerdict = LicenseVerdict | 'ignored' | 'internal'

/** One third-party package with the licenses its registry declares. */
export interface LicensedPackage {
  name: string
  version: string
  /** OSV ecosystem name, e.g. `npm`, `Go`, `PyPI`. */
  ecosystem: string
  /** Lockfiles or manifests the package was found in, relative to the checkout. */
  sources: string[]
  /** SPDX expressions as reported; empty when nothing is known. */
  licenses: string[]
  /** Dependency groups when the lockfile records them, e.g. `dev`, `optional`. */
  groups?: string[]
  verdict: PackageVerdict
  /** Licenses responsible for a verdict other than `allowed`. */
  culprits?: string[]
  /** For `internal` packages: the repository that defines it, as `forge:path`. */
  definedIn?: string
}

/** The policy a run evaluated against, kept so reports can show it. */
export interface LicensePolicyData {
  allow: string[]
  deny: string[]
  ignore: string[]
  /** `violation`: unknown licenses were judged not allowed. Missing in older records: `warn`. */
  unknown?: 'warn' | 'violation'
  /** The repository itself had to carry a license file. */
  requireProjectLicense?: boolean
}

/** Everything a `licenses` analysis found; serializable, stored as analysis data. */
export interface LicensesData {
  tool: { name: string; version?: string }
  policy: LicensePolicyData
  packages: LicensedPackage[]
  /** The checked-out repository itself; missing in older records. */
  project?: {
    /** License files at the repository root, e.g. `LICENSE`, `COPYING.md`. */
    licenseFiles: string[]
  }
}

const verdict = z.enum(['allowed', 'unknown', 'unlisted', 'denied', 'ignored', 'internal'])

/** Validates `LicensesData` uploads. */
export const licensesDataSchema: z.ZodType<LicensesData> = z.object({
  tool: z.object({ name: z.string(), version: z.string().optional() }),
  policy: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    ignore: z.array(z.string()),
    unknown: z.enum(['warn', 'violation']).optional(),
    requireProjectLicense: z.boolean().optional(),
  }),
  project: z.object({ licenseFiles: z.array(z.string()) }).optional(),
  packages: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      ecosystem: z.string(),
      sources: z.array(z.string()),
      licenses: z.array(z.string()),
      groups: z.array(z.string()).optional(),
      verdict,
      culprits: z.array(z.string()).optional(),
      definedIn: z.string().optional(),
    }),
  ),
})

/** Licenses accepted when no allow list is configured: permissive and public-domain licenses. */
export const defaultAllow: readonly string[] = [
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'Python-2.0',
  'BlueOak-1.0.0',
]

/** Licenses rejected when no deny list is configured: strong copyleft and source-available ones. */
export const defaultDeny: readonly string[] = ['GPL-*', 'AGPL-*', 'SSPL-*']

/** Problems: packages whose license is denied or not on the allow list. */
export const isViolation = (pkg: LicensedPackage) =>
  pkg.verdict === 'denied' || pkg.verdict === 'unlisted'

/** Identity of a package across versions, for comparing analyses. */
export const packageKey = (pkg: Pick<LicensedPackage, 'ecosystem' | 'name'>) =>
  `${pkg.ecosystem}:${pkg.name}`

/** How a package's licenses read in one line, e.g. `MIT OR Apache-2.0`. */
export const licenseText = (pkg: LicensedPackage) =>
  pkg.licenses.length === 0
    ? 'UNKNOWN'
    : pkg.licenses.length === 1
      ? (pkg.licenses[0] ?? 'UNKNOWN')
      : pkg.licenses.map((l) => `(${l})`).join(' AND ')
