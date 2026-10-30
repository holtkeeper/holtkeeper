import type { AuditReport, Finding, IgnoredFinding } from '@holtkeeper/api'
import { CalendarClock, CircleCheck, ShieldOff, User } from 'lucide-react'

import { expiryTone, formatDate, formatRelative } from '../../lib/format.ts'
import { Chip, EmptyState, Notice, SeverityChip, Table, Td, Th } from '../../ui/index.ts'

const advisory = (finding: Finding) =>
  finding.url ? (
    <a
      href={finding.url}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-accent hover:underline"
    >
      {finding.id}
    </a>
  ) : (
    <span className="font-mono text-xs">{finding.id}</span>
  )

/** Findings that were present before fixing and gone after the rescan. */
export function ResolvedList({ resolved }: { resolved: readonly Finding[] }) {
  if (resolved.length === 0) {
    return <EmptyState icon={<CircleCheck />} title="Nothing fixed in this run" />
  }
  return (
    <Table label="Resolved findings">
      <thead>
        <tr>
          <Th>Severity</Th>
          <Th>Package</Th>
          <Th>Advisory</Th>
          <Th>Source</Th>
        </tr>
      </thead>
      <tbody>
        {resolved.map((finding, i) => (
          <tr key={`${finding.id}-${finding.source}-${i}`}>
            <Td>
              <SeverityChip severity={finding.severity} />
            </Td>
            <Td className="font-mono text-[13px]">
              {finding.package.name}@
              <span className="line-through decoration-muted">{finding.package.version}</span>
            </Td>
            <Td>{advisory(finding)}</Td>
            <Td className="font-mono text-xs text-muted">{finding.source}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

function ExpiryChip({ expires }: { expires: string | undefined }) {
  const tone = expiryTone(expires ? `${expires}T23:59:59.999Z` : undefined)
  if (tone === 'none') return <span className="text-xs text-muted">no expiry</span>
  return (
    <Chip tone={tone === 'expired' ? 'danger' : tone === 'soon' ? 'warning' : 'default'}>
      <CalendarClock className="size-3" />
      {formatDate(`${expires}T00:00:00Z`)} · {formatRelative(`${expires}T23:59:59Z`)}
    </Chip>
  )
}

/** Findings hidden by the allowlist, with the reason and who added it. */
export function AllowlistedList({ ignored }: { ignored: readonly IgnoredFinding[] }) {
  if (ignored.length === 0) {
    return <EmptyState icon={<ShieldOff />} title="No allowlisted findings" />
  }
  return (
    <Table label="Allowlisted findings">
      <thead>
        <tr>
          <Th>Severity</Th>
          <Th>Package</Th>
          <Th>Advisory</Th>
          <Th>Reason</Th>
          <Th>Expires</Th>
        </tr>
      </thead>
      <tbody>
        {ignored.map(({ finding, entry }, i) => (
          <tr key={`${finding.id}-${finding.source}-${i}`}>
            <Td>
              <SeverityChip severity={finding.severity} />
            </Td>
            <Td>
              <div className="font-mono text-[13px]">
                {finding.package.name}@{finding.package.version}
              </div>
              <div className="font-mono text-[11px] text-muted">{finding.source}</div>
            </Td>
            <Td>{advisory(finding)}</Td>
            <Td>
              <div className="max-w-md text-sm">{entry.reason}</div>
              {entry.author ? (
                <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                  <User className="size-3" />
                  {entry.author}
                </div>
              ) : null}
            </Td>
            <Td>
              <ExpiryChip expires={entry.expires} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

/** Warns about allowlist entries past their date: they no longer hide anything. */
export function ExpiredAllowlist({ expired }: { expired: AuditReport['expired'] }) {
  if (expired.length === 0) return null
  return (
    <Notice
      tone="warning"
      title={`${expired.length} allowlist ${expired.length === 1 ? 'entry has' : 'entries have'} expired`}
    >
      <span className="block">
        Their findings count as active again. Renew or remove them in the allowlist setting.
      </span>
      <ul className="mt-2 flex flex-col gap-1">
        {expired.map((entry, i) => (
          <li key={`${entry.id}-${i}`} className="text-sm">
            <span className="font-mono text-xs">{entry.id}</span>
            {entry.package ? <span className="text-muted"> · {entry.package}</span> : null}
            {entry.expires ? (
              <span className="text-muted">
                {' '}
                · expired {formatDate(`${entry.expires}T00:00:00Z`)}
              </span>
            ) : null}
            <span className="text-muted"> — {entry.reason}</span>
          </li>
        ))}
      </ul>
    </Notice>
  )
}
