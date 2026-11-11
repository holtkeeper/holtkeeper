import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import { useJob, useJobAnalyzers } from '../../api/queries.ts'
import { analyzerLabel } from '../../lib/jobs.ts'
import { ErrorState, Page, Placeholder } from '../../ui/index.ts'
import { JobActions, JobDetail } from './JobDetail.tsx'

/** One job on its own page, the same detail the Jobs list opens in its side sheet. */
export function JobPage() {
  const { jobId } = useParams({ from: '/app/jobs/$jobId' })
  const job = useJob(jobId)
  const analyzers = useJobAnalyzers()

  if (job.isPending) return <Placeholder className="h-96" />
  if (job.isError) return <ErrorState error={job.error} />

  const label = analyzerLabel(analyzers.data?.analyzers ?? [], job.data.analyzer)
  return (
    <Page
      eyebrow={
        <Link to="/jobs" search={{}} className="inline-flex items-center gap-1 hover:underline">
          <ArrowLeft className="size-3.5" />
          Jobs
        </Link>
      }
      title={
        <span className="flex items-baseline gap-3">
          {label}
          <span className="mono text-xs font-normal text-muted">{job.data.id}</span>
        </span>
      }
      actions={<JobActions job={job.data} label={label} />}
    >
      <JobDetail job={job.data} />
    </Page>
  )
}
