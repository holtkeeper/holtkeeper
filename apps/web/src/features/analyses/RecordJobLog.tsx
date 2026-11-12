import type { AnalysisJobSummary } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ScrollText } from 'lucide-react'

import { useJob } from '../../api/queries.ts'
import { durationBetween, formatDateTime, formatRelative } from '../../lib/format.ts'
import { jobStatusLabel, jobStatusTone, jobTriggerLabel } from '../../lib/jobs.ts'
import { EmptyState, ErrorState, KeyValue, Notice, Placeholder, Tag } from '../../ui/index.ts'
import { JobLogView } from '../jobs/JobLogView.tsx'

/** The record page's Job log: the job behind the record and the log of its latest attempt. */
export function RecordJobLog({ job }: { job: AnalysisJobSummary | undefined }) {
  const full = useJob(job?.id)
  if (!job)
    return (
      <EmptyState
        icon={<ScrollText />}
        title="No job log"
        description="The record was uploaded, or its job has been pruned since."
      />
    )
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel px-3.5 py-3">
        <KeyValue
          rows={[
            {
              label: 'Job',
              value: (
                <Link
                  to="/ops/runs/$jobId"
                  params={{ jobId: job.id }}
                  className="mono hover:underline"
                >
                  {job.id.slice(0, 8)}
                </Link>
              ),
            },
            {
              label: 'Status',
              value: (
                <Tag tone={jobStatusTone(job.status)} dot>
                  {jobStatusLabel(job.status)}
                </Tag>
              ),
            },
            { label: 'Trigger', value: jobTriggerLabel(job.trigger) },
            {
              label: 'Queued',
              value: (
                <span title={formatDateTime(job.createdAt)}>{formatRelative(job.createdAt)}</span>
              ),
            },
            {
              label: 'Finished',
              value: job.finishedAt ? (
                <>
                  <span title={formatDateTime(job.finishedAt)}>
                    {formatRelative(job.finishedAt)}
                  </span>
                  <span className="text-muted">
                    · <span className="mono">{durationBetween(job.createdAt, job.finishedAt)}</span>{' '}
                    after queueing
                  </span>
                </>
              ) : null,
            },
          ]}
        />
        {job.error ? (
          <Notice tone="danger" title="Last attempt failed">
            {job.error}
          </Notice>
        ) : null}
      </section>
      <section className="rounded-xl border border-line bg-panel px-3.5 py-3">
        {full.isPending ? (
          <Placeholder className="h-48" />
        ) : full.isError ? (
          <ErrorState error={full.error} />
        ) : (
          <JobLogView
            key={full.data.attempts}
            jobId={job.id}
            attempt={full.data.attempts}
            live={full.data.status === 'running'}
          />
        )}
      </section>
    </div>
  )
}
