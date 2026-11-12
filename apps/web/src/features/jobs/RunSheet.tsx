import type { Job } from '@holtkeeper/api'
import { FileText } from 'lucide-react'
import { useState } from 'react'

import { useJobLog, useJobRuns } from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { shortId } from '../../lib/format.ts'
import { isActiveJob } from '../../lib/jobs.ts'
import { ErrorState, Placeholder, SideSheet, Tag, quietActionsOf } from '../../ui/index.ts'
import { JobDetail, type RunTab, useJobActions } from './JobDetail.tsx'
import { LOG_TAIL } from './JobLogView.tsx'
import { jobProgress } from './progress.ts'

const runTabIds: readonly RunTab[] = ['steps', 'logs', 'findings', 'cost']

interface Position {
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}

function Sheet({
  job,
  label,
  costUsd,
  onClose,
  ...position
}: {
  job: Job
  label: string
  costUsd?: number
  onClose: () => void
} & Position) {
  const actions = useJobActions(job, label)
  const [tab, setTab] = useState<RunTab>('steps')
  const log = useJobLog(job.id, job.attempts, job.status === 'running', LOG_TAIL)
  const runs = useJobRuns(job.id, isActiveJob(job))
  const cost = runs.data?.costUsd ?? costUsd
  const progress = jobProgress(log.data?.steps ?? [])
  const quiet = quietActionsOf(
    [actions.cancel, actions.runAgain].filter((action) => action !== undefined),
  )
  return (
    <>
      <SideSheet
        open
        onClose={onClose}
        id={`run ${shortId(job.id)}`}
        copyId={job.id}
        title={label}
        {...position}
        openAsPage={{ to: '/ops/runs/$jobId', params: { jobId: job.id } }}
        {...(progress && { progress })}
        quietActions={quiet}
        {...(actions.resultHref
          ? { more: [{ label: 'Open result', icon: FileText, href: actions.resultHref }] }
          : {})}
        tabs={{
          items: [
            { id: 'steps', label: 'Steps' },
            {
              id: 'logs',
              label: 'Logs',
              ...(job.status === 'running' && { badge: <Tag tone="info">live</Tag> }),
            },
            { id: 'findings', label: 'Findings' },
            {
              id: 'cost',
              label: 'Cost',
              ...(cost !== undefined && cost > 0 && { badge: formatUsd(cost) }),
            },
          ],
          selected: tab,
          onSelect: (id) => setTab(runTabIds.find((item) => item === id) ?? 'steps'),
          'aria-label': 'Run details',
        }}
      >
        <JobDetail
          job={job}
          tab={tab}
          onTab={setTab}
          {...(cost !== undefined && { costUsd: cost })}
        />
      </SideSheet>
      {actions.dialog}
    </>
  )
}

/**
 * A run opened from Ops › Runs in the side sheet, with Steps, Logs, Findings and Cost tabs; while
 * the run itself loads (for a run outside the loaded list) the sheet shows a placeholder.
 */
export function RunSheet({
  jobId,
  job,
  label,
  costUsd,
  error,
  onClose,
  ...position
}: {
  jobId: string
  job: Job | undefined
  label: string
  costUsd?: number
  error?: unknown
  onClose: () => void
} & Position) {
  if (!job)
    return (
      <SideSheet open onClose={onClose} id={`run ${shortId(jobId)}`} title="Run">
        {error ? <ErrorState error={error} /> : <Placeholder className="h-72" />}
      </SideSheet>
    )
  return (
    <Sheet
      key={job.id}
      job={job}
      label={label}
      onClose={onClose}
      {...(costUsd !== undefined && { costUsd })}
      {...position}
    />
  )
}
