import type { Finding, Severity } from '@holtkeeper/api'
import { useParams } from '@tanstack/react-router'
import { ExternalLink, FileDiff, PackageOpen, SearchX } from 'lucide-react'
import { useState } from 'react'

import { useAuditRun } from '../../api/queries.ts'
import { filterFindingRows, firstFix, sortFindingRows, toRows } from '../../lib/findings.ts'
import { durationBetween, formatDateTime, formatRelative } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import { triggerLabel } from '../../lib/security.ts'
import { severities, severityLabel, severityTone } from '../../lib/severity.ts'
import { httpUrl } from '../../lib/url.ts'
import {
  EmptyState,
  ErrorState,
  FilterButton,
  Page,
  Placeholder,
  SearchInput,
  SeverityBar,
  Strip,
  Table,
  Tag,
  Td,
  Th,
  UnderlineTabs,
} from '../../ui/index.ts'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { FixTimeline } from './FixTimeline.tsx'
import { AllowlistedList, ExpiredAllowlist, ResolvedList } from './OtherFindings.tsx'

const crumbs = (label: string) => [
  { label: 'Security', link: { to: '/supply/security' as const } },
  { label: 'Runs', link: { to: '/supply/security' as const, search: { view: 'runs' as const } } },
  { label },
]

function Advisory({ finding }: { finding: Finding }) {
  const url = httpUrl(finding.url)
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mono inline-flex items-center gap-1 text-[12.5px] hover:underline"
    >
      {finding.id}
      <ExternalLink className="size-3" />
    </a>
  ) : (
    <span className="mono text-[12.5px]">{finding.id}</span>
  )
}

function RunFindings({ findings }: { findings: readonly Finding[] }) {
  const [q, setQ] = useState('')
  const [severity, setSeverity] = useState<Severity[]>([])
  const all = sortFindingRows(toRows(findings))
  const rows = filterFindingRows(all, q, severity)
  if (!all.length)
    return (
      <EmptyState
        icon={<PackageOpen />}
        title="No active findings"
        description="Everything found is fixed or allowlisted."
      />
    )
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <SearchInput
          aria-label="Search findings"
          placeholder="Package, advisory, CVE, file"
          value={q}
          onChange={setQ}
          className="min-w-56 flex-1"
        />
        <FilterButton
          label="Severity"
          options={severities.map((id) => ({ id, label: severityLabel[id] }))}
          value={severity}
          onChange={(ids) => setSeverity(severities.filter((s) => ids.includes(s)))}
        />
        <span className="ms-auto text-xs text-muted" aria-live="polite">
          {rows.length === all.length ? all.length : `${rows.length} of ${all.length}`} findings
        </span>
      </div>
      {rows.length ? (
        <Table label="Active findings">
          <thead>
            <tr>
              <Th>Advisory</Th>
              <Th>Severity</Th>
              <Th>Package</Th>
              <Th>Version → fixed in</Th>
              <Th>Source</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, finding, info }) => (
              <tr key={key}>
                <Td>
                  <span className="flex flex-col leading-tight">
                    <Advisory finding={finding} />
                    {finding.summary ? (
                      <span className="max-w-md text-[11px] text-dim">{finding.summary}</span>
                    ) : null}
                  </span>
                </Td>
                <Td>
                  <Tag tone={severityTone(finding.severity)} dot>
                    {severityLabel[finding.severity]}
                  </Tag>
                </Td>
                <Td>
                  <span className="flex flex-col leading-tight">
                    <span className="mono text-[12.5px]">{finding.package.name}</span>
                    <span className="text-[11px] text-dim">{info.label}</span>
                  </span>
                </Td>
                <Td className="mono whitespace-nowrap text-[12.5px]">
                  {finding.package.version}
                  <span className="text-dim"> → </span>
                  {firstFix(finding) ? (
                    <span className="text-ok">{firstFix(finding)}</span>
                  ) : (
                    <span className="text-muted">no fix</span>
                  )}
                </Td>
                <Td className="mono text-[11px] text-muted">{finding.source}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState icon={<SearchX />} title="No findings match" />
      )}
    </div>
  )
}

function ChangedFiles({ files }: { files: readonly string[] }) {
  if (!files.length) return <EmptyState icon={<FileDiff />} title="No files changed" />
  return (
    <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-panel">
      {files.map((file) => (
        <li key={file} className="mono flex items-center gap-2 px-3.5 py-2 text-[12.5px]">
          <FileDiff className="size-3.5 text-muted" />
          {file}
        </li>
      ))}
    </ul>
  )
}

/** One audit run record: what was found, fixed and allowlisted, the fix attempts and files. */
export function AuditRunPage() {
  const { runId } = useParams({ from: '/app/supply/security/runs/$runId' })
  const detail = useAuditRun(runId)
  const [tab, setTab] = useState('findings')
  const repo = detail.data?.run.repo
  const again = useRunJob({ analyzer: 'audit', label: 'Run again', ...(repo ? { repo } : {}) })

  if (detail.isPending)
    return (
      <Page title="Audit run" crumbs={crumbs('Audit run')}>
        <Placeholder className="h-28" />
        <Placeholder className="h-96" />
      </Page>
    )
  if (detail.isError)
    return (
      <Page title="Audit run" crumbs={crumbs('Audit run')}>
        <ErrorState error={detail.error} />
      </Page>
    )

  const { run, summary } = detail.data
  const { report } = run

  return (
    <Page
      crumbs={crumbs(run.id.slice(0, 8))}
      title={<span className="mono">{run.repo.path}</span>}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {triggerLabel[run.trigger]}
            {run.actor ? ` by ${run.actor}` : ''}
          </span>
          <span>·</span>
          <span title={formatDateTime(run.finishedAt)}>{formatRelative(run.finishedAt)}</span>
          <span>·</span>
          <span className="mono">took {durationBetween(run.startedAt, run.finishedAt)}</span>
          <span>·</span>
          <span>{report.scanner}</span>
          <Tag mono>{repoKey(run.repo)}</Tag>
        </span>
      }
      primary={again.action}
    >
      <section className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel">
        <Strip
          cells={[
            {
              value: summary.active,
              label: 'active',
              tone: summary.active ? 'danger' : 'success',
            },
            {
              value: summary.resolved,
              label: 'fixed',
              tone: summary.resolved ? 'success' : 'none',
            },
            { value: summary.ignored, label: 'allowlisted' },
            {
              value: summary.expiredAllowlist,
              label: 'expired allowlist entries',
              tone: summary.expiredAllowlist ? 'warning' : 'none',
            },
            { value: summary.changedFiles, label: 'changed files', end: true },
          ]}
        />
        <div className="px-3.5 py-3">
          <SeverityBar counts={summary.severities} showLegend />
        </div>
      </section>

      <ExpiredAllowlist expired={report.expired} />

      <UnderlineTabs
        aria-label="Run sections"
        items={[
          { id: 'findings', label: 'Findings', badge: report.findings.length },
          { id: 'fixes', label: 'Fix attempts', badge: report.fixes.length },
          { id: 'resolved', label: 'Resolved', badge: report.resolved.length },
          { id: 'allowlisted', label: 'Allowlisted', badge: report.ignored.length },
          { id: 'files', label: 'Changed files', badge: report.changedFiles.length },
        ]}
        selected={tab}
        onSelect={setTab}
      />
      {tab === 'findings' ? (
        <RunFindings findings={report.findings} />
      ) : tab === 'fixes' ? (
        <FixTimeline fixes={report.fixes} />
      ) : tab === 'resolved' ? (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <ResolvedList resolved={report.resolved} />
        </div>
      ) : tab === 'allowlisted' ? (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <AllowlistedList ignored={report.ignored} />
        </div>
      ) : (
        <ChangedFiles files={report.changedFiles} />
      )}
      {again.dialog}
    </Page>
  )
}
