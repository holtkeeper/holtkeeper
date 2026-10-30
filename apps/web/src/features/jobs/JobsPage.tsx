import type { JobSummary } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, ListChecks, X } from 'lucide-react'

import { useJobAnalyzers, useJobs } from '../../api/queries.ts'
import { formatDateTime, formatDuration, formatRelative } from '../../lib/format.ts'
import {
  analyzerLabel,
  isJobStatus,
  jobDuration,
  jobStatusLabel,
  jobStatusTone,
  jobStatuses,
  jobTriggerLabel,
} from '../../lib/jobs.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  LinkButton,
  Page,
  Panel,
  Placeholder,
  Segmented,
  Table,
  Td,
  Th,
  Tooltip,
} from '../../ui/index.ts'
import { RunJobButton } from './RunJobDialog.tsx'

type StatusFilter = 'all' | (typeof jobStatuses)[number]

/** Background analyzer runs, newest first, filtered by status and optionally one repository. */
export function JobsPage() {
  const search = useSearch({ from: '/app/jobs' })
  const navigate = useNavigate({ from: '/jobs' })
  const status: StatusFilter = isJobStatus(search.status) ? search.status : 'all'
  const repo = parseRepoKey(search.repo)
  const jobs = useJobs({
    ...(status === 'all' ? {} : { status }),
    ...(repo ? { repo } : {}),
  })
  const analyzers = useJobAnalyzers()
  const list = jobs.data?.jobs ?? []
  const now = new Date()

  const setStatus = (next: StatusFilter) =>
    void navigate({
      search: (previous) => ({
        ...(previous.repo ? { repo: previous.repo } : {}),
        ...(next === 'all' ? {} : { status: next }),
      }),
    })

  return (
    <Page
      title="Jobs"
      description="Background analyzer runs, newest first"
      actions={<RunJobButton {...(repo ? { repo } : {})} />}
    >
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-2">
            Runs
            {repo ? (
              <Chip tone="accent">
                <span className="font-mono text-xs">{repo.path}</span>
                <Link
                  to="/jobs"
                  search={status === 'all' ? {} : { status }}
                  aria-label="Show every repository"
                  className="ml-1 inline-flex"
                >
                  <X className="size-3" />
                </Link>
              </Chip>
            ) : null}
          </span>
        }
        actions={
          <Segmented
            aria-label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { id: 'all', label: 'All' },
              ...jobStatuses.map((id) => ({ id, label: jobStatusLabel(id) })),
            ]}
          />
        }
      >
        {jobs.isPending ? (
          <Placeholder className="h-72" />
        ) : jobs.isError ? (
          <ErrorState error={jobs.error} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<ListChecks />}
            title={
              status === 'all' ? 'No jobs yet' : `No ${jobStatusLabel(status).toLowerCase()} jobs`
            }
            description="Schedules, triggers and manual runs queue analyzer jobs here."
            action={
              status === 'all' ? null : (
                <Button variant="secondary" size="sm" onPress={() => setStatus('all')}>
                  Show all
                </Button>
              )
            }
          />
        ) : (
          <Table label="Jobs">
            <thead>
              <tr>
                <Th>Status</Th>
                <Th>Analyzer</Th>
                <Th>Target</Th>
                <Th>Ref</Th>
                <Th>Trigger</Th>
                <Th>Created</Th>
                <Th align="right">Duration</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {list.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  label={analyzerLabel(analyzers.data?.analyzers ?? [], job.analyzer)}
                  now={now}
                />
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  )
}

function JobRow({ job, label, now }: { job: JobSummary; label: string; now: Date }) {
  const duration = jobDuration(job, now)
  return (
    <tr>
      <Td>
        <Chip tone={jobStatusTone(job.status)}>{jobStatusLabel(job.status)}</Chip>
      </Td>
      <Td>
        <Link to="/jobs/$jobId" params={{ jobId: job.id }} className="font-medium hover:underline">
          {label}
        </Link>
      </Td>
      <Td>
        {job.group !== undefined ? (
          <Link
            to="/repos/groups/$groupId"
            params={{ groupId: job.group }}
            search={{}}
            className="hover:underline"
          >
            Group {job.group}
          </Link>
        ) : (
          <Link
            to="/repos/view"
            search={{ repo: repoKey(job.repo) }}
            className="font-mono text-xs hover:underline"
          >
            {job.repo.path}
          </Link>
        )}
      </Td>
      <Td>
        {job.ref ? (
          <span className="font-mono text-xs">{job.ref}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
      <Td className="text-muted">{jobTriggerLabel(job.trigger)}</Td>
      <Td className="whitespace-nowrap">
        <Tooltip content={formatDateTime(job.createdAt)}>
          <time tabIndex={0} dateTime={job.createdAt}>
            {formatRelative(job.createdAt, now)}
          </time>
        </Tooltip>
      </Td>
      <Td align="right" className="whitespace-nowrap tabular-nums">
        {duration === undefined ? <span className="text-muted">—</span> : formatDuration(duration)}
      </Td>
      <Td align="right">
        <LinkButton
          to="/jobs/$jobId"
          params={{ jobId: job.id }}
          variant="ghost"
          size="sm"
          aria-label="Open job"
        >
          <ChevronRight className="size-4" />
        </LinkButton>
      </Td>
    </tr>
  )
}
