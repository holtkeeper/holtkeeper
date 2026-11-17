import { canonicalJson } from '@holtkeeper/store'
import {
  type AllowlistEntry,
  type AuditReport,
  type Finding,
  type Traits,
  applyAllowlist,
} from '@holtkeeper/vuln'
import { type OsvRecord, findingsForPackage } from '@holtkeeper/vuln-osv'

import type { InventoryPackage } from './inventory.ts'
import { packageKey } from './match.ts'

/** The `scanner` of audit reports the index writes. */
export const INDEX_SCANNER = 'osv-index'

/** Options of `indexAuditReport`. */
export interface IndexAuditOptions {
  packages: readonly InventoryPackage[]
  /** Advisories by `packageKey`, as `matchPackages` returns them. */
  records: ReadonlyMap<string, readonly OsvRecord[]>
  allowlist?: readonly AllowlistEntry[]
  traits?: Traits
  now?: Date
}

const order = (finding: Finding) =>
  [
    finding.source,
    finding.package.ecosystem,
    finding.package.name,
    finding.package.version,
    finding.id,
  ].join('\0')

const byOrder = (a: Finding, b: Finding) => order(a).localeCompare(order(b))

/**
 * The audit report of one repository's inventory: findings of every matched package (one per
 * issue, package version and source), the allowlist applied as `runAudit` applies it, and no fix
 * attempts. Findings are sorted by source, package, version and id, so equal inputs give equal
 * reports.
 */
export function indexAuditReport(options: IndexAuditOptions): AuditReport {
  const findings = options.packages
    .flatMap((pkg) =>
      findingsForPackage(
        { ecosystem: pkg.ecosystem, name: pkg.name, version: pkg.version },
        pkg.source,
        options.records.get(packageKey(pkg)) ?? [],
      ),
    )
    .toSorted(byOrder)
  const { active, ignored, expired } = applyAllowlist(findings, options.allowlist ?? [], {
    ...(options.now && { now: options.now }),
    ...(options.traits && { traits: options.traits }),
  })
  return {
    scanner: INDEX_SCANNER,
    findings: active,
    ignored,
    expired,
    fixes: [],
    resolved: [],
    changedFiles: [],
  }
}

const stateOf = (report: Pick<AuditReport, 'findings' | 'ignored' | 'expired'>) =>
  canonicalJson({
    findings: report.findings.toSorted(byOrder),
    ignored: report.ignored.toSorted((a, b) => byOrder(a.finding, b.finding)),
    expired: report.expired.toSorted((a, b) => a.id.localeCompare(b.id)),
  })

/**
 * Whether two reports describe the same state: the same active and allowlisted findings and the
 * same expired entries, in any order. Scanner names and fix attempts do not count.
 */
export const sameAuditState = (
  a: Pick<AuditReport, 'findings' | 'ignored' | 'expired'>,
  b: Pick<AuditReport, 'findings' | 'ignored' | 'expired'>,
) => stateOf(a) === stateOf(b)

/**
 * What a fix could act on: active findings that have a fixed version, as
 * `<advisory>|<ecosystem>|<package>|<version>`, sorted and unique. A new key means a fix run has
 * something it did not have before: a new advisory, an advisory that got its first fixed version,
 * or another resolved version of the package.
 */
export function fixableKeys(report: Pick<AuditReport, 'findings'>): string[] {
  const keys = report.findings
    .filter((finding) => finding.fixedVersions.length > 0)
    .map((finding) =>
      [finding.id, finding.package.ecosystem, finding.package.name, finding.package.version].join(
        '|',
      ),
    )
  return [...new Set(keys)].toSorted()
}
