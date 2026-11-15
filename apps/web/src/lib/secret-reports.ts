import type {
  SecretExposureChannel,
  SecretReportKind,
  SecretReportStatus,
  SecretReportView,
  SecretReportingMode,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { formatDateTime } from './format.ts'
import { searchText } from './search-params.ts'

/** The reporting choices of a token, in the order the panel offers them. */
export const reportingModeOptions: readonly { id: SecretReportingMode; label: string }[] = [
  { id: 'named', label: 'Under my name' },
  { id: 'anonymous', label: 'Anonymously' },
  { id: 'off', label: 'Off' },
]

/** The short word a token's reporting choice reads as in the token table. */
export const reportingModeShort: Record<SecretReportingMode, string> = {
  named: 'named',
  anonymous: 'anonymous',
  off: 'off',
}

/** Kinds of secrets in display order, with their labels. */
export const secretKindLabels: Record<SecretReportKind, string> = {
  'api-key': 'API key',
  token: 'Token',
  password: 'Password',
  'private-key': 'Private key',
  certificate: 'Certificate',
  'connection-string': 'Connection string',
  'webhook-url': 'Webhook URL',
  other: 'Other',
}

/** Where a secret showed up, as a label. */
export const exposureChannelLabels: Record<SecretExposureChannel, string> = {
  chat: 'Chat',
  'command-output': 'Command output',
  'file-read': 'File read',
  commit: 'Commit',
  log: 'Log',
  'issue-or-merge-request': 'Issue or merge request',
  other: 'Other',
}

/** Report statuses in workflow order, with their label and tone. */
export const reportStatusLabels: Record<SecretReportStatus, { label: string; tone: StatusTone }> = {
  new: { label: 'New', tone: 'danger' },
  acknowledged: { label: 'Acknowledged', tone: 'warning' },
  rotated: { label: 'Rotated', tone: 'success' },
  'false-positive': { label: 'False positive', tone: 'default' },
}

const statuses: readonly SecretReportStatus[] = ['new', 'acknowledged', 'rotated', 'false-positive']

/** Whether a report still needs action: `new` and `acknowledged` are open. */
export const isOpenReport = (status: SecretReportStatus): boolean =>
  status === 'new' || status === 'acknowledged'

/** The status filter of the reports table: open ones (default), all, or one status. */
export type ReportStatusFilter = 'open' | 'all' | SecretReportStatus

/** Status filters in the order the page offers them. */
export const reportStatusFilters: readonly ReportStatusFilter[] = ['open', 'all', ...statuses]

/** Label of a status filter. */
export const reportStatusFilterLabel = (filter: ReportStatusFilter): string =>
  filter === 'open' ? 'Open' : filter === 'all' ? 'All' : reportStatusLabels[filter].label

const matchesStatus = (status: SecretReportStatus, filter: ReportStatusFilter) =>
  filter === 'all' || (filter === 'open' ? isOpenReport(status) : status === filter)

/** How many reports each status filter keeps. */
export function reportStatusCounts(
  reports: readonly Pick<SecretReportView, 'status'>[],
): Record<ReportStatusFilter, number> {
  const counts: Record<ReportStatusFilter, number> = {
    open: 0,
    all: 0,
    new: 0,
    acknowledged: 0,
    rotated: 0,
    'false-positive': 0,
  }
  for (const report of reports)
    for (const filter of reportStatusFilters)
      if (matchesStatus(report.status, filter)) counts[filter] += 1
  return counts
}

/** What the reports table is narrowed to. */
export interface ReportFilter {
  status: ReportStatusFilter
  /** Empty keeps every kind. */
  kinds: readonly SecretReportKind[]
  /** Matched case-insensitively against identifier, service and repository. */
  query: string
}

/**
 * The reports `filter` keeps, newest first. Anonymous reports only carry their day, so on the
 * same day they sort with the named ones by that day's start.
 */
export function filterReports<
  T extends Pick<
    SecretReportView,
    'status' | 'kind' | 'identifier' | 'service' | 'repo' | 'reportedAt'
  >,
>(reports: readonly T[], filter: ReportFilter): T[] {
  const needle = filter.query.trim().toLowerCase()
  return reports
    .filter(
      (report) =>
        matchesStatus(report.status, filter.status) &&
        (!filter.kinds.length || filter.kinds.includes(report.kind)) &&
        (!needle ||
          [report.identifier, report.service, report.repo].some((text) =>
            text?.toLowerCase().includes(needle),
          )),
    )
    .toSorted((a, b) => b.reportedAt.localeCompare(a.reportedAt))
}

/** Whether a report came without its sender. */
export const isAnonymousReport = (report: Pick<SecretReportView, 'reporter'>): boolean =>
  report.reporter === undefined

/**
 * When a report arrived as the page may show it: date and time, marked approximate (`≈`) for
 * anonymous reports, whose stored time is moved back by up to 10 minutes.
 */
export const reportedLabel = (report: Pick<SecretReportView, 'reporter' | 'reportedAt'>): string =>
  isAnonymousReport(report)
    ? `≈ ${formatDateTime(report.reportedAt)}`
    : formatDateTime(report.reportedAt)

/** `×3` for a report repeated three more times; empty when it was not repeated. */
export const repeatsLabel = (repeats: number): string => (repeats > 0 ? `×${repeats}` : '')

/** The CLI command DevOps run to find a fingerprint's secret in an OpenBao or Vault KV engine. */
export const secretsMatchCommand = (fingerprint: string): string =>
  `holtkeeper secrets match ${fingerprint} --address https://bao.example.com --mount secret`

/** Status changes offered for a report in its current status. */
export function reportStatusActions(
  status: SecretReportStatus,
): { status: SecretReportStatus; label: string }[] {
  if (!isOpenReport(status)) return [{ status: 'new', label: 'Reopen' }]
  return [
    ...(status === 'new' ? [{ status: 'acknowledged' as const, label: 'Acknowledge' }] : []),
    { status: 'rotated', label: 'Mark rotated' },
    { status: 'false-positive', label: 'False positive' },
  ]
}

/** Search parameters of `/supply/secret-reports`. */
export interface SecretReportsSearch {
  /** The report open in the sheet. */
  report?: string
}

/** Reads `/supply/secret-reports` search parameters, dropping unknown values. */
export function parseSecretReportsSearch(search: Record<string, unknown>): SecretReportsSearch {
  const report = searchText(search.report)
  return report ? { report } : {}
}
