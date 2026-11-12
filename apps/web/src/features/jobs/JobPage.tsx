import type { Job } from '@holtkeeper/api'
import { useParams } from '@tanstack/react-router'
import { FileText } from 'lucide-react'

import { missingOf } from '../../api/client.ts'
import { useJob, useJobAnalyzers } from '../../api/queries.ts'
import { shortId } from '../../lib/format.ts'
import { analyzerLabel } from '../../lib/jobs.ts'
import { ErrorState, Page, Placeholder } from '../../ui/index.ts'
import { Forbidden } from '../shell/Forbidden.tsx'
import { JobDetail, useJobActions } from './JobDetail.tsx'

function JobView({ job, label }: { job: Job; label: string }) {
  const actions = useJobActions(job, label)
  return (
    <Page
      crumbs={[
        { label: 'Runs', link: { to: '/ops/runs', search: {} } },
        { label: <span className="mono">{shortId(job.id)}</span> },
      ]}
      title={
        <span className="flex items-baseline gap-3">
          {label}
          <span className="mono text-xs font-normal text-muted">{job.id}</span>
        </span>
      }
      primary={actions.runAgain}
      more={[
        ...(actions.resultHref
          ? [{ label: 'Open result', icon: FileText, href: actions.resultHref }]
          : []),
        ...(actions.cancel
          ? [
              {
                label: actions.cancel.label,
                icon: actions.cancel.icon,
                onAction: actions.cancel.onPress,
                danger: true,
              },
            ]
          : []),
      ]}
    >
      <JobDetail job={job} />
      {actions.dialog}
    </Page>
  )
}

/** One job on its own page, the same detail the Runs list opens in its side sheet. */
export function JobPage() {
  const { jobId } = useParams({ from: '/app/ops/runs/$jobId' })
  const job = useJob(jobId)
  const analyzers = useJobAnalyzers()

  if (job.isPending || job.isError)
    return (
      <Page
        crumbs={[
          { label: 'Runs', link: { to: '/ops/runs', search: {} } },
          { label: <span className="mono">{shortId(jobId)}</span> },
        ]}
      >
        {job.isPending ? (
          <Placeholder className="h-96" />
        ) : missingOf(job.error) ? (
          <Forbidden error={job.error} />
        ) : (
          <ErrorState error={job.error} />
        )}
      </Page>
    )
  return (
    <JobView
      job={job.data}
      label={analyzerLabel(analyzers.data?.analyzers ?? [], job.data.analyzer)}
    />
  )
}
