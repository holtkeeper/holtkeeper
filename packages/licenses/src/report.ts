import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Block, Cell, Issue, Metric, Report, Section, Tone } from '@holtkeeper/report'

import {
  isDevOnly,
  isViolation,
  licensesDataSchema,
  licenseText,
  packageKey,
  type LicensedPackage,
  type LicensesData,
  type PackageVerdict,
} from './model.ts'

/** How many rows long lists show before summarizing the rest; slices in the donut. */
const limits = { packages: 2000, unknown: 500, internal: 500, slices: 12 }

const verdictTone: Record<PackageVerdict, Tone> = {
  allowed: 'good',
  unknown: 'warning',
  unlisted: 'warning',
  denied: 'bad',
  ignored: 'neutral',
  internal: 'neutral',
  excepted: 'neutral',
}

const verdictLabel: Record<PackageVerdict, string> = {
  allowed: 'allowed',
  unknown: 'unknown',
  unlisted: 'not allowed',
  denied: 'denied',
  ignored: 'ignored',
  internal: 'internal',
  excepted: 'excepted',
}

function counts(data: LicensesData) {
  const licenses = new Set(data.packages.filter((pkg) => pkg.licenses.length > 0).map(licenseText))
  return {
    packages: data.packages.length,
    violations: data.packages.filter(isViolation).length,
    denied: data.packages.filter((pkg) => pkg.verdict === 'denied').length,
    unknown: data.packages.filter((pkg) => pkg.verdict === 'unknown').length,
    internal: data.packages.filter((pkg) => pkg.verdict === 'internal').length,
    excepted: data.packages.filter((pkg) => pkg.verdict === 'excepted').length,
    licenses: licenses.size,
  }
}

/** Package keys (`ecosystem:name`) per verdict that needs attention, sorted. */
export interface FlaggedPackages {
  denied: string[]
  unlisted: string[]
  unknown: string[]
}

/** Stored headline numbers of one `licenses` record. */
export interface LicensesMetrics {
  packages: number
  /** Packages per verdict; every verdict is present, zero when no package has it. */
  verdicts: Record<PackageVerdict, number>
  /** Packages whose license is denied or not on the allow list. */
  violations: number
  /** The policy asked for a repository license file and the repository has none. */
  missingProjectLicense: boolean
  /** Whether the repository carries a license file, `not-required` when the policy does not ask. */
  licenseFile: 'present' | 'missing' | 'not-required'
  /** Third-party packages (internal ones left out) per license expression; `UNKNOWN` for none. */
  licenses: Record<string, number>
  /** License expressions of the packages the policy allows, sorted. */
  allowedLicenses: string[]
  /** Which packages are denied, not on the allow list or of unknown license. */
  flagged: FlaggedPackages
  /** Details of every package in `flagged`, by `ecosystem:name`. */
  flaggedDetails: Record<string, FlaggedPackage>
  /**
   * Every package by `ecosystem:name`: its license expressions over all its versions, sorted, and
   * its worst verdict. Absent on records stored before it was kept.
   */
  byPackage?: Record<string, PackageLicenses>
}

/** The licenses and worst verdict of one package over all its versions in a scan. */
export interface PackageLicenses {
  licenses: string[]
  verdict: PackageVerdict
}

/** A verdict that needs attention. */
export type FlaggedVerdict = 'denied' | 'unlisted' | 'unknown'

/** One flagged package of a scan over all its flagged versions. */
export interface FlaggedPackage {
  name: string
  ecosystem: string
  /** Flagged versions, sorted. */
  versions: string[]
  /** Declared license ids of those versions, sorted. */
  licenses: string[]
  /** The worst verdict of those versions. */
  verdict: FlaggedVerdict
  /** Licenses responsible for the verdict, sorted. */
  culprits: string[]
  /** Every flagged version is only in the `dev` dependency group. */
  dev: boolean
}

const verdictOrder: readonly PackageVerdict[] = [
  'denied',
  'unlisted',
  'unknown',
  'excepted',
  'allowed',
  'internal',
  'ignored',
]

/** Orders verdicts worst first: denied, unlisted, unknown, excepted, allowed, internal, ignored. */
export const compareVerdict = (a: PackageVerdict, b: PackageVerdict) =>
  verdictOrder.indexOf(a) - verdictOrder.indexOf(b)

const isFlagged = (verdict: PackageVerdict): verdict is FlaggedVerdict =>
  verdict === 'denied' || verdict === 'unlisted' || verdict === 'unknown'

const merged = (values: readonly string[], more: readonly string[]) =>
  [...new Set([...values, ...more])].toSorted()

function flaggedDetails(packages: LicensedPackage[]): Record<string, FlaggedPackage> {
  const found: Record<string, FlaggedPackage> = {}
  for (const pkg of packages) {
    if (!isFlagged(pkg.verdict)) continue
    const key = packageKey(pkg)
    const dev = isDevOnly(pkg.groups)
    const known = found[key]
    found[key] = known
      ? {
          ...known,
          versions: merged(known.versions, [pkg.version]),
          licenses: merged(known.licenses, pkg.licenses),
          verdict: compareVerdict(pkg.verdict, known.verdict) < 0 ? pkg.verdict : known.verdict,
          culprits: merged(known.culprits, pkg.culprits ?? []),
          dev: known.dev && dev,
        }
      : {
          name: pkg.name,
          ecosystem: pkg.ecosystem,
          versions: [pkg.version],
          licenses: merged([], pkg.licenses),
          verdict: pkg.verdict,
          culprits: merged([], pkg.culprits ?? []),
          dev,
        }
  }
  return found
}

function byPackage(packages: LicensedPackage[]): Record<string, PackageLicenses> {
  const found: Record<string, PackageLicenses> = {}
  for (const pkg of packages) {
    const key = packageKey(pkg)
    const text = pkg.licenses.join(' AND ')
    const known = found[key]
    if (!known) {
      found[key] = { licenses: text ? [text] : [], verdict: pkg.verdict }
      continue
    }
    if (text && !known.licenses.includes(text))
      known.licenses = [...known.licenses, text].toSorted()
    if (compareVerdict(pkg.verdict, known.verdict) < 0) known.verdict = pkg.verdict
  }
  return found
}

const sortedKeys = (packages: LicensedPackage[], verdict: PackageVerdict) =>
  [...new Set(packages.filter((pkg) => pkg.verdict === verdict).map(packageKey))].toSorted()

/** `LicensesMetrics` of `data`. */
export function licensesMetrics(data: LicensesData): LicensesMetrics {
  const verdicts: Record<PackageVerdict, number> = {
    allowed: 0,
    unknown: 0,
    unlisted: 0,
    denied: 0,
    ignored: 0,
    internal: 0,
    excepted: 0,
  }
  const licenses: Record<string, number> = {}
  const allowed = new Set<string>()
  for (const pkg of data.packages) {
    verdicts[pkg.verdict] += 1
    if (pkg.verdict === 'internal') continue
    const text = licenseText(pkg)
    licenses[text] = (licenses[text] ?? 0) + 1
    if (pkg.verdict === 'allowed') allowed.add(text)
  }
  const missing = missingProjectLicense(data)
  return {
    packages: data.packages.length,
    verdicts,
    violations: data.packages.filter(isViolation).length,
    missingProjectLicense: missing,
    licenseFile: missing
      ? 'missing'
      : data.policy.requireProjectLicense === true && data.project
        ? 'present'
        : 'not-required',
    licenses,
    allowedLicenses: [...allowed].toSorted(),
    flagged: {
      denied: sortedKeys(data.packages, 'denied'),
      unlisted: sortedKeys(data.packages, 'unlisted'),
      unknown: sortedKeys(data.packages, 'unknown'),
    },
    flaggedDetails: flaggedDetails(data.packages),
    byPackage: byPackage(data.packages),
  }
}

/** Whether the policy asked for a repository license file and the repository has none. */
const missingProjectLicense = (data: LicensesData) =>
  data.policy.requireProjectLicense === true && data.project?.licenseFiles.length === 0

const problem = (value: number, tone: 'warning' | 'bad'): Partial<Metric> =>
  value > 0 ? { tone } : { tone: 'good' }

function metrics(data: LicensesData, previous?: LicensesData): Metric[] {
  const now = counts(data)
  const before = previous ? counts(previous) : undefined
  return [
    metric('packages', 'Packages', now.packages, {
      previous: before?.packages,
      hint: 'Third-party packages in lockfiles and manifests',
    }),
    {
      ...metric('violations', 'License violations', now.violations, {
        previous: before?.violations,
        better: 'down',
        hint: 'Denied or not on the allow list',
      }),
      ...problem(now.violations, now.denied > 0 ? 'bad' : 'warning'),
    },
    {
      ...metric('unknown', 'Unknown licenses', now.unknown, {
        previous: before?.unknown,
        better: 'down',
      }),
      ...problem(now.unknown, 'warning'),
    },
    metric('licenses', 'Distinct licenses', now.licenses, { previous: before?.licenses }),
    ...(now.internal > 0 || (before?.internal ?? 0) > 0
      ? [
          metric('internal', 'Internal packages', now.internal, {
            previous: before?.internal,
            hint: 'Defined by analyzed repositories; not judged',
          }),
        ]
      : []),
    ...(now.excepted > 0 || (before?.excepted ?? 0) > 0
      ? [
          metric('excepted', 'Excepted packages', now.excepted, {
            previous: before?.excepted,
            hint: 'Accepted by a policy exception',
          }),
        ]
      : []),
    ...(data.policy.requireProjectLicense && data.project
      ? [
          {
            ...metric(
              'project-license',
              'Repository license files',
              data.project.licenseFiles.length,
              {
                hint: 'LICENSE, COPYING or similar at the repository root',
              },
            ),
            ...(missingProjectLicense(data)
              ? { tone: 'warning' as const }
              : { tone: 'good' as const }),
          },
        ]
      : []),
  ]
}

const projectLicenseIssue: Issue = {
  id: 'project-license-missing',
  tone: 'warning',
  title: 'The repository has no license file',
  detail:
    'Add a LICENSE file at the repository root so users know the terms, or turn off requireProjectLicense for private code.',
  tags: ['repository'],
}

const kindOf = (pkg: LicensedPackage) => pkg.groups?.join(', ')

function violationIssue(pkg: LicensedPackage, isNew: boolean): Issue {
  const kind = kindOf(pkg)
  return {
    id: `license-${pkg.ecosystem}-${pkg.name}@${pkg.version}`,
    tone: verdictTone[pkg.verdict],
    title: `${pkg.name}@${pkg.version}: ${licenseText(pkg)} (${verdictLabel[pkg.verdict]})`,
    detail: [
      pkg.culprits && pkg.culprits.length > 0 ? `Offending: ${pkg.culprits.join(', ')}` : undefined,
      `Found in ${pkg.sources.join(', ')}`,
      kind ? `Dependency kind: ${kind}` : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
    tags: [pkg.ecosystem, ...(pkg.groups ?? []), ...(isNew ? ['new'] : [])],
  }
}

function violationsSection(
  data: LicensesData,
  previous?: LicensesData,
  compareTo?: string,
): Section {
  const violations = data.packages
    .filter(isViolation)
    .toSorted((a, b) =>
      a.verdict === b.verdict ? a.name.localeCompare(b.name) : a.verdict === 'denied' ? -1 : 1,
    )
  const before = previous
    ? new Map(previous.packages.filter(isViolation).map((pkg) => [packageKey(pkg), pkg]))
    : undefined
  const issues = [
    ...(missingProjectLicense(data) ? [projectLicenseIssue] : []),
    ...violations.map((pkg) => violationIssue(pkg, before ? !before.has(packageKey(pkg)) : false)),
  ]
  const blocks: Block[] = [
    issues.length > 0
      ? { type: 'issues', items: issues }
      : { type: 'markdown', text: 'Every package has an allowed license.' },
  ]

  if (previous && before) {
    const now = new Map(violations.map((pkg) => [packageKey(pkg), pkg]))
    const rows: Record<string, Cell>[] = [
      ...[...now]
        .filter(([key]) => !before.has(key))
        .map(([, pkg]) => ({
          package: pkg.name,
          version: pkg.version,
          license: licenseText(pkg),
          status: { text: 'new', tone: 'bad' as const },
        })),
      ...[...before]
        .filter(([key]) => !now.has(key))
        .map(([, pkg]) => ({
          package: pkg.name,
          version: pkg.version,
          license: licenseText(pkg),
          status: { text: 'resolved', tone: 'good' as const },
        })),
    ]
    blocks.push(
      rows.length > 0
        ? {
            type: 'table',
            title: `Since ${compareTo ?? 'previous analysis'}`,
            columns: [
              { key: 'package', label: 'Package', format: 'code' },
              { key: 'version', label: 'Version', unit: 'version' },
              { key: 'license', label: 'License', format: 'code' },
              { key: 'status', label: 'Status' },
            ],
            rows,
          }
        : {
            type: 'markdown',
            text: `No violations appeared or were resolved since ${compareTo ?? 'the previous analysis'}.`,
          },
    )
  }

  return {
    id: 'violations',
    title: 'Violations',
    description: `Allowed: ${data.policy.allow.join(', ') || 'nothing'}. Denied: ${data.policy.deny.join(', ') || 'nothing'}.${data.policy.unknown === 'violation' ? ' Unknown licenses are not allowed.' : ''}`,
    blocks,
  }
}

/** A package's license as the report shows it; internal packages read `internal`. */
const shownLicense = (pkg: LicensedPackage) =>
  pkg.verdict === 'internal' && pkg.licenses.length === 0 ? 'internal' : licenseText(pkg)

function mixSection(data: LicensesData): Section {
  const byLicense = new Map<string, number>()
  for (const pkg of data.packages) {
    const text = shownLicense(pkg)
    byLicense.set(text, (byLicense.get(text) ?? 0) + 1)
  }
  const sorted = [...byLicense].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = sorted.slice(0, limits.slices)
  const other = sorted.slice(limits.slices).reduce((total, [, count]) => total + count, 0)
  const rows = [
    ...shown.map(([license, packages]) => ({ license, packages })),
    ...(other > 0 ? [{ license: 'Other', packages: other }] : []),
  ]
  return {
    id: 'license-mix',
    title: 'License mix',
    blocks:
      rows.length > 0
        ? [
            {
              type: 'chart',
              title: 'Packages by license',
              chart: 'donut',
              unit: 'count',
              x: 'license',
              series: [{ key: 'packages', label: 'Packages' }],
              data: rows,
            },
          ]
        : [{ type: 'markdown', text: 'No packages found.' }],
  }
}

function capped(rows: Record<string, Cell>[], limit: number, what: string): Block[] {
  return rows.length > limit
    ? [{ type: 'markdown', text: `…and ${rows.length - limit} more ${what}.` }]
    : []
}

function unknownSection(data: LicensesData): Section {
  const rows = data.packages
    .filter((pkg) => pkg.verdict === 'unknown')
    .map((pkg) => ({
      package: pkg.name,
      version: pkg.version,
      ecosystem: pkg.ecosystem,
      declared: pkg.licenses.join(', ') || null,
      source: pkg.sources.join(', '),
    }))
  return {
    id: 'unknown',
    title: 'Unknown licenses',
    description:
      'Packages whose registry declares no license, or one that is not an SPDX expression. Check them by hand.',
    blocks:
      rows.length > 0
        ? [
            {
              type: 'table',
              columns: [
                { key: 'package', label: 'Package', format: 'code' },
                { key: 'version', label: 'Version', unit: 'version' },
                { key: 'ecosystem', label: 'Ecosystem' },
                { key: 'declared', label: 'Declared', format: 'code' },
                { key: 'source', label: 'Source', format: 'code' },
              ],
              rows: rows.slice(0, limits.unknown),
            },
            ...capped(rows, limits.unknown, 'packages'),
          ]
        : [{ type: 'markdown', text: 'Every package declares a recognizable license.' }],
  }
}

function internalSection(data: LicensesData): Section | undefined {
  const rows = data.packages
    .filter((pkg) => pkg.verdict === 'internal')
    .map((pkg) => ({
      package: pkg.name,
      version: pkg.version,
      definedIn: pkg.definedIn ?? null,
      source: pkg.sources.join(', '),
    }))
  if (rows.length === 0) return undefined
  return {
    id: 'internal',
    title: 'Internal packages',
    description:
      'Packages that analyzed repositories define. Their licenses are not judged; registries outside the company know nothing about them.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'package', label: 'Package', format: 'code' },
          { key: 'version', label: 'Version', unit: 'version' },
          { key: 'definedIn', label: 'Repository', format: 'code' },
          { key: 'source', label: 'Source', format: 'code' },
        ],
        rows: rows.slice(0, limits.internal),
      },
      ...capped(rows, limits.internal, 'packages'),
    ],
  }
}

function exceptedSection(data: LicensesData): Section | undefined {
  const rows = data.packages
    .filter((pkg) => pkg.verdict === 'excepted')
    .map((pkg) => ({
      package: pkg.name,
      version: pkg.version,
      license: licenseText(pkg),
      reason: pkg.exception ?? null,
    }))
  if (rows.length === 0) return undefined
  return {
    id: 'excepted',
    title: 'Exceptions',
    description: 'Packages a policy exception accepts although their license would not pass.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'package', label: 'Package', format: 'code' },
          { key: 'version', label: 'Version', unit: 'version' },
          { key: 'license', label: 'License', format: 'code' },
          { key: 'reason', label: 'Reason' },
        ],
        rows: rows.slice(0, limits.internal),
      },
      ...capped(rows, limits.internal, 'packages'),
    ],
  }
}

function packagesSection(data: LicensesData): Section {
  const rows: Record<string, Cell>[] = data.packages.map((pkg) => ({
    package: pkg.name,
    version: pkg.version,
    ecosystem: pkg.ecosystem,
    license: shownLicense(pkg),
    verdict: { text: verdictLabel[pkg.verdict], tone: verdictTone[pkg.verdict] },
    kind: kindOf(pkg) ?? null,
    source: pkg.sources.join(', '),
  }))
  return {
    id: 'packages',
    title: 'Packages',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'package', label: 'Package', format: 'code' },
          { key: 'version', label: 'Version', unit: 'version' },
          { key: 'ecosystem', label: 'Ecosystem' },
          { key: 'license', label: 'License', format: 'code' },
          { key: 'verdict', label: 'Verdict' },
          { key: 'kind', label: 'Kind', format: 'tags' },
          { key: 'source', label: 'Source', format: 'code' },
        ],
        rows: rows.slice(0, limits.packages),
      },
      ...capped(rows, limits.packages, 'packages'),
    ],
  }
}

/** Turns `LicensesData` into a report. Exported for tests and for clients that render locally. */
export function licensesReport(
  data: LicensesData,
  options: { previous?: LicensesData; ref?: string; compareTo?: string; generatedAt?: string } = {},
): Omit<Report, 'subject'> {
  const { previous, compareTo } = options
  return {
    kind: 'licenses',
    title: 'Licenses',
    ...(options.ref ? { subtitle: options.ref } : {}),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    metrics: metrics(data, previous),
    sections: [
      violationsSection(data, previous, compareTo),
      mixSection(data),
      unknownSection(data),
      ...[internalSection(data), exceptedSection(data)].filter((section) => section !== undefined),
      packagesSection(data),
    ],
  }
}

/**
 * The `licenses` analysis kind: third-party packages with their declared licenses, judged against
 * an allow and a deny list. Problem metrics carry `better: 'down'`.
 */
export const licensesAnalysis = defineAnalysis<LicensesData, LicensesMetrics>({
  kind: 'licenses',
  label: 'Licenses',
  schema: licensesDataSchema,
  summarize: (data) => metrics(data),
  metrics: licensesMetrics,
  toReport(current, previous) {
    return {
      ...licensesReport(current.data, {
        previous: previous?.data,
        ref: current.ref,
        compareTo: previous?.ref,
      }),
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(previous?.ref ? { compareTo: previous.ref } : {}),
      },
    }
  },
})
