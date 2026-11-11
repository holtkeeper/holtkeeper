import type { JobFailureGroup, JobSummary, PersonView } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ExternalLink, ListChecks, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import {
  useJob,
  useJobAnalyzers,
  useJobFailures,
  useJobTargets,
  useJobs,
} from '../../api/queries.ts'
import { formatDateTime, formatDuration, formatRelative } from '../../lib/format.ts'
import {
  analyzerLabel,
  isJobStatus,
  isJobTrigger,
  jobDuration,
  jobScopeRepos,
  jobStatusLabel,
  jobStatusTone,
  jobStatuses,
  jobTriggerLabel,
  jobTriggers,
  jobsSearchWith,
  type JobsSearch,
  uniqueJobs,
} from '../../lib/jobs.ts'
import { personOf } from '../../lib/people.ts'
import { parseRepoKey } from '../../lib/repo.ts'
import {
  Avatar,
  EmptyState,
  ErrorState,
  LinkButton,
  LoadMore,
  Page,
  Placeholder,
  ScopeSwitch,
  Segmented,
  SegmentedTabs,
  Select,
  SideSheet,
  Tag,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { JobActions, JobDetail } from './JobDetail.tsx'
import { RunJobButton } from './RunJobDialog.tsx'

const any = 'any'

const rowGrid =
  'grid grid-cols-[112px_minmax(0,1fr)_72px] items-center gap-x-3 md:grid-cols-[132px_minmax(0,160px)_minmax(0,1fr)_minmax(0,130px)_72px_56px_88px]'

const failureGrid =
  'grid grid-cols-[minmax(0,1fr)_56px] items-center gap-x-3 md:grid-cols-[minmax(0,150px)_minmax(0,1fr)_56px_56px_96px_64px]'

const dayOptions = [
  { id: '1', label: '24h' },
  { id: '7', label: '7d' },
  { id: '30', label: '30d' },
] as const

function FilterTag({
  children,
  onClear,
  label,
}: {
  children: ReactNode
  onClear: () => void
  label: string
}) {
  return (
    <Tag className="gap-1.5">
      {children}
      <button
        type="button"
        aria-label={label}
        onClick={onClear}
        className="text-muted hover:text-current"
      >
        <X className="size-3" />
      </button>
    </Tag>
  )
}

function JobRow({
  job,
  label,
  person,
  now,
  onOpen,
}: {
  job: JobSummary
  label: string
  person?: PersonView
  now: Date
  onOpen: () => void
}) {
  const duration = jobDuration(job, now)
  const started = job.startedAt ?? job.createdAt
  const blocked = job.status === 'blocked'
  return (
    <li className="border-b border-line last:border-b-0 hover:bg-raise">
      <button
        type="button"
        onClick={onOpen}
        className={`${rowGrid} min-h-9 w-full px-3 py-1.5 text-left`}
      >
        <span>
          <Tag tone={jobStatusTone(job.status)} dot>
            {jobStatusLabel(job.status)}
          </Tag>
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{label}</span>
          {blocked && job.error ? (
            <span className="truncate text-[11px] text-warn" title={job.error}>
              {job.error}
            </span>
          ) : null}
        </span>
        <span className="mono hidden truncate text-xs text-muted md:block" title={job.repo.path}>
          {job.group !== undefined ? `group ${job.group}` : job.repo.path}
        </span>
        <span className="hidden min-w-0 items-center gap-1.5 truncate text-xs text-muted md:flex">
          {person ? <Avatar src={person.avatarUrl} name={person.name} size="xs" /> : null}
          <span className="truncate">{job.schedule ?? jobTriggerLabel(job.trigger)}</span>
        </span>
        <span className="mono hidden text-right text-xs tabular md:block">
          {duration === undefined ? <span className="text-dim">—</span> : formatDuration(duration)}
        </span>
        <span
          className={`mono hidden text-right text-xs tabular md:block ${job.attempts > 1 ? 'text-warn' : 'text-muted'}`}
        >
          {job.attempts}/{job.maxAttempts}
        </span>
        <time
          dateTime={started}
          title={formatDateTime(started)}
          className="mono truncate text-right text-xs text-muted"
        >
          {formatRelative(started, now)}
        </time>
      </button>
    </li>
  )
}

function FailureRow({
  group,
  label,
  now,
  onShow,
  onLatest,
}: {
  group: JobFailureGroup
  label: string
  now: Date
  onShow: () => void
  onLatest: () => void
}) {
  return (
    <li
      className={`${failureGrid} min-h-9 border-b border-line px-3 py-1.5 last:border-b-0 hover:bg-raise`}
    >
      <button
        type="button"
        onClick={onShow}
        className="hidden truncate text-left font-medium md:block"
      >
        {label}
      </button>
      <button
        type="button"
        onClick={onShow}
        className="flex min-w-0 flex-col text-left"
        title={group.error}
      >
        <span className="mono truncate text-xs">{group.errorSignature || '(no message)'}</span>
        <span className="truncate text-[11px] text-muted md:hidden">{label}</span>
      </button>
      <span className="mono text-right text-xs text-bad tabular">{group.count}×</span>
      <span
        className="mono hidden text-right text-xs text-muted tabular md:block"
        title="Repositories"
      >
        {group.repos}
      </span>
      <time
        dateTime={group.lastAt}
        title={`First ${formatDateTime(group.firstAt)}, last ${formatDateTime(group.lastAt)}`}
        className="mono hidden truncate text-right text-xs text-muted md:block"
      >
        {formatRelative(group.lastAt, now)}
      </time>
      <button
        type="button"
        onClick={onLatest}
        className="hidden text-right text-xs text-muted hover:underline md:block"
      >
        latest
      </button>
    </li>
  )
}

function ListFrame({
  header,
  children,
  footer,
}: {
  header: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel text-[13px]">
      <div className="hidden border-b border-line px-3 py-2 text-xs text-dim md:block" aria-hidden>
        {header}
      </div>
      {children}
      {footer ? <div className="border-t border-line p-2">{footer}</div> : null}
    </section>
  )
}

const loading = (
  <div className="flex flex-col gap-1 p-3">
    {Array.from({ length: 8 }, (_, i) => (
      <Placeholder key={i} className="h-7" />
    ))}
  </div>
)

/**
 * Background analyzer runs: a dense list filtered by status, analyzer, repository, trigger,
 * schedule and failure signature within the scope switch, and a Failures view that groups failed
 * jobs by cause. A row opens the job in the side sheet (J/K step through the list).
 */
export function JobsPage() {
  const search = useSearch({ from: '/app/jobs' })
  const navigate = useNavigate({ from: '/jobs' })
  const { view, setView, homeGroups } = useScope()
  const targets = useJobTargets()
  const analyzers = useJobAnalyzers()
  const [openId, setOpenId] = useState<string>()
  const [days, setDays] = useState<(typeof dayOptions)[number]['id']>('7')
  const [now] = useState(() => new Date())

  const failuresView = search.view === 'failures'
  const status = isJobStatus(search.status) ? search.status : undefined
  const trigger = isJobTrigger(search.trigger) ? search.trigger : undefined
  const repo = parseRepoKey(search.repo)
  const scoped = repo ? undefined : jobScopeRepos(view, targets.data?.targets, homeGroups)
  const ready = view === 'all' || repo !== undefined || targets.isSuccess
  const nothingInScope = scoped !== undefined && scoped.length === 0

  const jobs = useJobs(
    {
      ...(status && { status }),
      ...(trigger && { trigger }),
      ...(repo && { repo }),
      ...(scoped && { repos: scoped }),
      ...(search.analyzer && { analyzer: search.analyzer }),
      ...(search.schedule && { schedule: search.schedule }),
      ...(search.signature && { signature: search.signature }),
    },
    ready && !nothingInScope && !failuresView,
  )
  const failures = useJobFailures(
    {
      days: Number(days),
      ...(search.analyzer && { analyzer: search.analyzer }),
      ...(repo ? { repos: [search.repo ?? ''] } : scoped && { repos: scoped }),
    },
    ready && !nothingInScope,
  )

  const list = uniqueJobs((jobs.data?.pages ?? []).map((page) => page.jobs))
  const people: Record<string, PersonView> = {}
  for (const page of jobs.data?.pages ?? []) Object.assign(people, page.people)
  const labelOf = (kind: string) => analyzerLabel(analyzers.data?.analyzers ?? [], kind)

  const navList = failuresView ? [] : list
  const index = navList.findIndex((job) => job.id === openId)
  const opened = useJob(openId)
  const openJob = opened.data ?? (index >= 0 ? navList[index] : undefined)

  const set = (patch: Partial<JobsSearch>) =>
    void navigate({ search: (previous) => jobsSearchWith(previous, patch) })

  const pick = (value: string) => (value === any ? undefined : value)

  const failureCount = failures.data?.failures.reduce((sum, group) => sum + group.count, 0)

  return (
    <Page
      title="Jobs"
      icon="jobs"
      description="Background analyzer runs, newest first"
      actions={
        <>
          <ScopeSwitch value={view} onChange={setView} />
          <RunJobButton size="sm" {...(repo ? { repo } : {})} />
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs
          aria-label="Jobs view"
          selected={failuresView ? 'failures' : 'all'}
          onSelect={(id) => set({ view: id === 'failures' ? 'failures' : undefined })}
          items={[
            { id: 'all', label: 'All jobs' },
            {
              id: 'failures',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Failures
                  {failureCount ? <span className="tabular text-bad">{failureCount}</span> : null}
                </span>
              ),
            },
          ]}
        />
        {failuresView ? null : (
          <Select
            aria-label="Status"
            options={[
              { id: any, label: 'Any status' },
              ...jobStatuses.map((id) => ({ id, label: jobStatusLabel(id) })),
            ]}
            value={status ?? any}
            onChange={(value) => set({ status: pick(value) })}
            className="w-40"
          />
        )}
        <Select
          aria-label="Analyzer"
          options={[
            { id: any, label: 'Any analyzer' },
            ...(analyzers.data?.analyzers ?? []).map((analyzer) => ({
              id: analyzer.kind,
              label: analyzer.label,
            })),
          ]}
          value={search.analyzer ?? any}
          onChange={(value) => set({ analyzer: pick(value) })}
          className="w-44"
        />
        <Select
          aria-label="Repository"
          options={[
            { id: any, label: 'Any repository' },
            ...(targets.data?.targets ?? []).map((target) => ({
              id: target.repo,
              label: (
                <span className="mono text-xs">
                  {target.group !== undefined ? `group ${target.group}` : target.repo}
                </span>
              ),
              text: target.repo,
            })),
          ]}
          value={search.repo ?? any}
          onChange={(value) => set({ repo: pick(value) })}
          className="w-64"
        />
        {failuresView ? (
          <Segmented aria-label="Time range" options={dayOptions} value={days} onChange={setDays} />
        ) : (
          <Select
            aria-label="Trigger"
            options={[
              { id: any, label: 'Any trigger' },
              ...jobTriggers.map((id) => ({ id, label: jobTriggerLabel(id) })),
            ]}
            value={trigger ?? any}
            onChange={(value) => set({ trigger: pick(value) })}
            className="w-40"
          />
        )}
        {search.schedule && !failuresView ? (
          <FilterTag label="Show every schedule" onClear={() => set({ schedule: undefined })}>
            Schedule {search.schedule}
          </FilterTag>
        ) : null}
        {search.signature && !failuresView ? (
          <FilterTag label="Show every failure" onClear={() => set({ signature: undefined })}>
            <span className="mono max-w-80 truncate" title={search.signature}>
              {search.signature}
            </span>
          </FilterTag>
        ) : null}
      </div>

      {targets.isError ? (
        <ErrorState error={targets.error} />
      ) : nothingInScope ? (
        <EmptyState
          icon={<ListChecks />}
          title="No repositories here"
          description="Switch the scope to see jobs of other repositories."
        />
      ) : failuresView ? (
        <ListFrame
          header={
            <div className={failureGrid}>
              <span>Analyzer</span>
              <span>Failure</span>
              <span className="text-right">Jobs</span>
              <span className="text-right">Repos</span>
              <span className="text-right">Last seen</span>
              <span />
            </div>
          }
        >
          {failures.isPending ? (
            loading
          ) : failures.isError ? (
            <ErrorState error={failures.error} />
          ) : failures.data.failures.length === 0 ? (
            <EmptyState
              icon={<ListChecks />}
              title="No failures"
              description="Nothing failed for good in this time range."
            />
          ) : (
            <ul>
              {failures.data.failures.map((group) => (
                <FailureRow
                  key={`${group.analyzer}:${group.errorSignature}`}
                  group={group}
                  label={labelOf(group.analyzer)}
                  now={now}
                  onShow={() =>
                    set({
                      view: undefined,
                      status: 'failed',
                      analyzer: group.analyzer,
                      signature: group.errorSignature,
                    })
                  }
                  onLatest={() => setOpenId(group.latestJobId)}
                />
              ))}
            </ul>
          )}
        </ListFrame>
      ) : (
        <ListFrame
          header={
            <div className={rowGrid}>
              <span>Status</span>
              <span>Analyzer</span>
              <span>Repository</span>
              <span>Trigger</span>
              <span className="text-right">Duration</span>
              <span className="text-right">Tries</span>
              <span className="text-right">Started</span>
            </div>
          }
          footer={
            jobs.hasNextPage ? (
              <LoadMore
                onLoad={() => void jobs.fetchNextPage()}
                isPending={jobs.isFetchingNextPage}
              >
                Load older
              </LoadMore>
            ) : undefined
          }
        >
          {!ready || jobs.isPending ? (
            loading
          ) : jobs.isError ? (
            <ErrorState error={jobs.error} />
          ) : list.length === 0 ? (
            <EmptyState
              icon={<ListChecks />}
              title="No jobs"
              description="Schedules, triggers and manual runs queue analyzer jobs here. Loosen the filters to see more."
            />
          ) : (
            <ul>
              {list.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  label={labelOf(job.analyzer)}
                  {...(job.actor && { person: personOf(people, job.actor) })}
                  now={now}
                  onOpen={() => setOpenId(job.id)}
                />
              ))}
            </ul>
          )}
        </ListFrame>
      )}

      <SideSheet
        open={openId !== undefined}
        onClose={() => setOpenId(undefined)}
        id={openId?.slice(0, 8)}
        title={openJob ? labelOf(openJob.analyzer) : 'Job'}
        {...(index >= 0 && { index, total: navList.length })}
        {...(index > 0 && { onPrevious: () => setOpenId(navList[index - 1]?.id) })}
        {...(index >= 0 &&
          index < navList.length - 1 && { onNext: () => setOpenId(navList[index + 1]?.id) })}
        actions={
          openJob ? (
            <>
              <JobActions job={openJob} label={labelOf(openJob.analyzer)} />
              <LinkButton
                to="/jobs/$jobId"
                params={{ jobId: openJob.id }}
                variant="ghost"
                size="sm"
                aria-label="Open the job page"
              >
                <ExternalLink className="size-3.5" />
              </LinkButton>
            </>
          ) : null
        }
      >
        {openJob ? (
          <JobDetail key={openJob.id} job={openJob} />
        ) : opened.isError ? (
          <ErrorState error={opened.error} />
        ) : (
          <Placeholder className="h-72" />
        )}
      </SideSheet>
    </Page>
  )
}
