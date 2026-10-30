import { Link, useParams } from '@tanstack/react-router'
import {
  ArrowLeft,
  CircleCheck,
  Clock,
  FileDiff,
  ScanSearch,
  ShieldAlert,
  ShieldOff,
  TimerOff,
  Zap,
} from 'lucide-react'
import { motion } from 'motion/react'

import { useAuditRun } from '../../api/queries.ts'
import { durationBetween, formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Chip,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  SeverityBar,
  StatCard,
  Tabs,
  stagger,
} from '../../ui/index.ts'
import { FindingsExplorer } from './FindingsExplorer.tsx'
import { FixTimeline } from './FixTimeline.tsx'
import { triggerLabel } from './labels.ts'
import { AllowlistedList, ExpiredAllowlist, ResolvedList } from './OtherFindings.tsx'

/** One audit run: what was found, what was fixed, what is allowlisted. */
export function AuditRunPage() {
  const { runId } = useParams({ from: '/app/audits/$runId' })
  const detail = useAuditRun(runId)

  if (detail.isPending) {
    return (
      <Page title="Audit run">
        <Placeholder className="h-28" />
        <Placeholder className="h-96" />
      </Page>
    )
  }
  if (detail.isError)
    return (
      <Page title="Audit run">
        <ErrorState error={detail.error} />
      </Page>
    )

  const { run, summary } = detail.data
  const { report } = run
  const key = repoKey(run.repo)

  return (
    <Page
      icon="audit"
      eyebrow={
        <Link
          to="/audits"
          search={{ repo: key }}
          className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus"
        >
          <ArrowLeft className="size-3.5" />
          Runs of {run.repo.forge}:{run.repo.path}
        </Link>
      }
      title={run.repo.path}
      description={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <Zap className="size-3.5" />
            {triggerLabel[run.trigger]}
            {run.actor ? ` by ${run.actor}` : ''}
          </span>
          <span className="inline-flex items-center gap-1" title={formatDateTime(run.finishedAt)}>
            <Clock className="size-3.5" />
            {formatRelative(run.finishedAt)} · took {durationBetween(run.startedAt, run.finishedAt)}
          </span>
          <span className="inline-flex items-center gap-1">
            <ScanSearch className="size-3.5" />
            {report.scanner}
          </span>
          <Chip>{run.repo.forge}</Chip>
        </span>
      }
    >
      <Panel>
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">Severity distribution</span>
            <span className="text-xs text-muted">{plural(summary.active, 'active finding')}</span>
          </div>
          <SeverityBar counts={summary.severities} height="h-3" showLegend />
        </div>
      </Panel>

      <motion.div {...stagger} className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Active"
          value={summary.active}
          icon={<ShieldAlert />}
          accent="var(--sev-high)"
        />
        <StatCard
          label="Fixed"
          value={summary.resolved}
          icon={<CircleCheck />}
          accent="var(--series-3)"
        />
        <StatCard
          label="Allowlisted"
          value={summary.ignored}
          icon={<ShieldOff />}
          accent="var(--series-7)"
        />
        <StatCard
          label="Expired allowlist"
          value={summary.expiredAllowlist}
          icon={<TimerOff />}
          accent={summary.expiredAllowlist ? 'var(--sev-medium)' : undefined}
        />
        <StatCard
          label="Changed files"
          value={summary.changedFiles}
          icon={<FileDiff />}
          accent="var(--series-1)"
        />
      </motion.div>

      <ExpiredAllowlist expired={report.expired} />

      <Tabs
        aria-label="Report sections"
        items={[
          {
            id: 'findings',
            label: `Findings · ${report.findings.length}`,
            content: <FindingsExplorer findings={report.findings} />,
          },
          {
            id: 'fixes',
            label: `Fix attempts · ${report.fixes.length}`,
            content: <FixTimeline fixes={report.fixes} />,
          },
          {
            id: 'resolved',
            label: `Resolved · ${report.resolved.length}`,
            content: (
              <Panel>
                <ResolvedList resolved={report.resolved} />
              </Panel>
            ),
          },
          {
            id: 'allowlisted',
            label: `Allowlisted · ${report.ignored.length}`,
            content: (
              <Panel>
                <AllowlistedList ignored={report.ignored} />
              </Panel>
            ),
          },
          {
            id: 'files',
            label: `Changed files · ${report.changedFiles.length}`,
            content: (
              <Panel>
                {report.changedFiles.length ? (
                  <ul className="flex flex-col divide-y divide-separator">
                    {report.changedFiles.map((file) => (
                      <li key={file} className="flex items-center gap-2 py-2 font-mono text-[13px]">
                        <FileDiff className="size-4 text-muted" />
                        {file}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState icon={<FileDiff />} title="No files changed" />
                )}
              </Panel>
            ),
          },
        ]}
      />
    </Page>
  )
}
