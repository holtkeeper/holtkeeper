import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Block, Cell, Issue, Metric, Report, Section, Tone } from '@holtkeeper/report'

import {
  isViolation,
  licensesDataSchema,
  licenseText,
  packageKey,
  type LicensedPackage,
  type LicensesData,
  type PackageVerdict,
} from './model.ts'

/** How many rows long lists show before summarizing the rest; slices in the donut. */
const limits = { packages: 2000, unknown: 500, slices: 12 }

const verdictTone: Record<PackageVerdict, Tone> = {
  allowed: 'good',
  unknown: 'warning',
  unlisted: 'warning',
  denied: 'bad',
  ignored: 'neutral',
}

const verdictLabel: Record<PackageVerdict, string> = {
  allowed: 'allowed',
  unknown: 'unknown',
  unlisted: 'not allowed',
  denied: 'denied',
  ignored: 'ignored',
}

function counts(data: LicensesData) {
  const licenses = new Set(data.packages.filter((pkg) => pkg.licenses.length > 0).map(licenseText))
  return {
    packages: data.packages.length,
    violations: data.packages.filter(isViolation).length,
    denied: data.packages.filter((pkg) => pkg.verdict === 'denied').length,
    unknown: data.packages.filter((pkg) => pkg.verdict === 'unknown').length,
    licenses: licenses.size,
  }
}

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
  ]
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
  const blocks: Block[] = [
    violations.length > 0
      ? {
          type: 'issues',
          items: violations.map((pkg) =>
            violationIssue(pkg, before ? !before.has(packageKey(pkg)) : false),
          ),
        }
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
    description: `Allowed: ${data.policy.allow.join(', ') || 'nothing'}. Denied: ${data.policy.deny.join(', ') || 'nothing'}.`,
    blocks,
  }
}

function mixSection(data: LicensesData): Section {
  const byLicense = new Map<string, number>()
  for (const pkg of data.packages) {
    const text = licenseText(pkg)
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

function packagesSection(data: LicensesData): Section {
  const rows: Record<string, Cell>[] = data.packages.map((pkg) => ({
    package: pkg.name,
    version: pkg.version,
    ecosystem: pkg.ecosystem,
    license: licenseText(pkg),
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
      packagesSection(data),
    ],
  }
}

/**
 * The `licenses` analysis kind: third-party packages with their declared licenses, judged against
 * an allow and a deny list. Problem metrics carry `better: 'down'`.
 */
export const licensesAnalysis = defineAnalysis<LicensesData>({
  kind: 'licenses',
  label: 'Licenses',
  schema: licensesDataSchema,
  summarize: (data) => metrics(data),
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
