import type { JobSummary, JobWait, PersonView } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  CalendarClock,
  Clock,
  FolderPlus,
  GitCommitHorizontal,
  GitPullRequest,
  ListChecks,
  type LucideIcon,
  RefreshCw,
  Tag as TagIcon,
  Terminal,
  User,
  Workflow,
  X,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'

import {
  useJob,
  useJobAnalyzers,
  useJobCount,
  useJobFailures,
  useJobStats,
  useJobTargets,
  useJobs,
} from '../../api/queries.ts'
import { formatDateTime, formatDuration, formatRef } from '../../lib/format.ts'
import {
  type JobTrigger,
  type JobsSearch,
  type RunsSegment,
  analyzerLabel,
  jobDuration,
  jobScopeRepos,
  jobStatusLabel,
  jobStatusTone,
  jobStatuses,
  jobTriggerLabel,
  jobTriggers,
  jobsSearchWith,
  runCostText,
  runStartedText,
  runSubline,
  runsFilter,
  runsSegment,
  runsSegmentWith,
  uniqueJobs,
} from '../../lib/jobs.ts'
import { personOf } from '../../lib/people.ts'
import { parseRepoKey } from '../../lib/repo.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import { useNow } from '../../lib/use-now.ts'
import {
  Avatar,
  EmptyState,
  ErrorState,
  FilterButton,
  Kbd,
  Legend,
  ListFooter,
  LoadMore,
  Page,
  Placeholder,
  SegmentedTabs,
  Table,
  Tag,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'
import { copyLinkItem } from '../shell/copy-link.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { QueueHealth } from './QueueHealth.tsx'
import { type FailureRange, RecurringFailures } from './RecurringFailures.tsx'
import { useRunJob } from './RunJobDialog.tsx'
import { RunSheet } from './RunSheet.tsx'

const triggerIcons: Record<JobTrigger, LucideIcon> = {
  schedule: CalendarClock,
  manual: User,
  command: Terminal,
  webhook: GitPullRequest,
  tag: TagIcon,
  push: GitCommitHorizontal,
  poll: Clock,
  'new-repo': FolderPlus,
  freshness: RefreshCw,
}

const sublineTones = { muted: 'text-muted', warning: 'text-warn', danger: 'text-bad' } as const

function FilterChip({
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

function RunRow({
  job,
  labelOf,
  person,
  wait,
  costUsd,
  selected,
  now,
  onOpen,
}: {
  job: JobSummary
  labelOf: (kind: string) => string
  person?: PersonView
  wait?: JobWait
  costUsd?: number
  selected: boolean
  now: Date
  onOpen: () => void
}) {
  const duration = jobDuration(job, now)
  const subline = runSubline(job, wait, now, labelOf)
  const TriggerIcon = triggerIcons[job.trigger] ?? Clock
  const started = job.startedAt ?? job.createdAt
  return (
    <Tr selected={selected} onClick={onOpen}>
      <Td className="whitespace-nowrap">
        <Tag tone={jobStatusTone(job.status)} dot>
          {jobStatusLabel(job.status)}
        </Tag>
      </Td>
      <Td className="max-w-[22rem]">
        <div className="truncate font-medium">{labelOf(job.analyzer)}</div>
        {subline ? (
          <div
            className={`mono truncate text-[11px] ${sublineTones[subline.tone]}`}
            title={subline.text}
          >
            {subline.text}
          </div>
        ) : null}
      </Td>
      <Td className="max-w-[18rem]">
        <span className="mono block truncate text-xs" title={job.repo.path}>
          {job.group !== undefined ? `group ${job.group}` : job.repo.path}
          {job.ref ? <span className="text-dim"> {formatRef(job.ref)}</span> : null}
        </span>
      </Td>
      <Td className="max-w-[12rem]">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
          {person ? (
            <Avatar src={person.avatarUrl} name={person.name} size="xs" />
          ) : (
            <TriggerIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className={`truncate ${job.schedule ? 'mono' : ''}`}>
            {job.schedule ?? (person ? person.name : jobTriggerLabel(job.trigger))}
          </span>
        </span>
      </Td>
      <Td align="right">
        <span className="mono text-xs tabular">
          {duration === undefined ? <span className="text-dim">—</span> : formatDuration(duration)}
        </span>
      </Td>
      <Td align="right">
        <span className={`mono text-xs tabular ${job.attempts > 1 ? 'text-warn' : 'text-muted'}`}>
          {job.attempts}/{job.maxAttempts}
        </span>
      </Td>
      <Td align="right">
        <span className="mono text-xs tabular text-muted">{runCostText(costUsd)}</span>
      </Td>
      <Td className="whitespace-nowrap">
        <time dateTime={started} title={formatDateTime(started)} className="text-xs text-muted">
          {runStartedText(job, now)}
        </time>
      </Td>
    </Tr>
  )
}

const statusLegend = [
  { tone: 'info', label: 'Running' },
  { tone: 'success', label: 'Succeeded' },
  { tone: 'danger', label: 'Failed' },
  { tone: 'code', label: 'Blocked by budget' },
  { tone: 'default', label: 'Queued, Canceled' },
] as const

const segmentCaptions: Record<RunsSegment, string> = {
  all: 'newest first',
  failures: 'failed for good, newest first',
  queue: 'waiting to start, newest first',
}

/**
 * Ops › Runs: background analyzer runs in three segments (All, Failures, Queue) with filter pills,
 * the queue strip, live workers and why runs wait from `GET /api/jobs/stats`, a dense table with
 * cost and a line under each run (its wait hint, failure or earlier attempt), and recurring
 * failures under the table. A row opens the run in the side sheet (J/K step through the list).
 */
export function JobsPage() {
  const search = useSearch({ from: '/app/ops/runs' })
  const navigate = useNavigate({ from: '/ops/runs' })
  const { view, setView, homeGroups } = useScope()
  const { canGlobal } = useSession()
  const targets = useJobTargets()
  const analyzers = useJobAnalyzers()
  const [openId, setOpenId] = useState<string>()
  const [range, setRange] = useState<FailureRange>('7')
  const now = useNow()

  const segment = runsSegment(search)
  const searchText = useDebounced(search.q, 300)
  const filter = runsFilter({ ...search, q: searchText })
  const repo = parseRepoKey(search.repo)
  const scoped = repo ? undefined : jobScopeRepos(view, targets.data?.targets, homeGroups)
  const ready = view === 'all' || repo !== undefined || targets.isSuccess
  const nothingInScope = scoped !== undefined && scoped.length === 0
  const scopeRepos = repo ? [search.repo ?? ''] : scoped

  const jobQuery = { ...filter, ...(repo && { repo }), ...(scoped && { repos: scoped }) }
  const jobs = useJobs(jobQuery, ready && !nothingInScope)
  const jobCount = useJobCount(jobQuery, ready && !nothingInScope)
  const stats = useJobStats(scopeRepos, ready && !nothingInScope)
  const failures = useJobFailures(
    {
      days: Number(range),
      ...(search.analyzer && { analyzer: search.analyzer }),
      ...(scopeRepos && { repos: scopeRepos }),
    },
    ready && !nothingInScope && segment !== 'queue',
  )

  const pages = jobs.data?.pages ?? []
  const people: Record<string, PersonView> = {}
  const waits: Record<string, JobWait> = {}
  const costs: Record<string, number> = {}
  for (const page of pages) {
    Object.assign(people, page.people)
    Object.assign(waits, page.waitHints)
    Object.assign(costs, page.costs)
  }
  const labelOf = (kind: string) => analyzerLabel(analyzers.data?.analyzers ?? [], kind)
  const list = uniqueJobs(pages.map((page) => page.jobs))

  const index = list.findIndex((job) => job.id === openId)
  const opened = useJob(openId)
  const openJob = opened.data ?? (index >= 0 ? list[index] : undefined)
  const run = useRunJob(repo ? { repo } : {})

  const set = (patch: Partial<JobsSearch>) =>
    void navigate({ search: (previous) => jobsSearchWith(previous, patch), replace: true })
  const setSegment = (next: RunsSegment) =>
    void navigate({ search: (previous) => runsSegmentWith(previous, next) })

  const queued = stats.data?.queue.queued
  const failed = stats.data?.queue.failed

  return (
    <Page
      crumbs={[{ label: 'Runs' }]}
      scope={{ value: view, onChange: setView }}
      search={{
        value: search.q ?? '',
        onChange: (q) => set({ q }),
        'aria-label': 'Filter runs',
        placeholder: 'Filter by id, repository, analyzer',
      }}
      {...(canGlobal('settings:read') && {
        configure: {
          link: {
            to: '/settings/$section',
            params: { section: 'analyzers' },
            search: search.analyzer ? { item: search.analyzer } : {},
          },
        },
      })}
      more={[
        copyLinkItem,
        ...(search.schedule
          ? [
              {
                label: 'Show on Automation',
                icon: Workflow,
                href: `/ops/automation?schedule=${encodeURIComponent(search.schedule)}`,
              },
            ]
          : []),
      ]}
      primary={run.action}
      filters={
        <>
          <SegmentedTabs
            aria-label="Runs view"
            selected={segment}
            onSelect={(id) => setSegment(id === 'failures' || id === 'queue' ? id : 'all')}
            items={[
              { id: 'all', label: 'All' },
              {
                id: 'failures',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    Failures
                    {failed ? (
                      <span
                        className="tabular text-bad"
                        title={`${failed} failed in the last ${stats.data?.windowHours ?? 24} h`}
                      >
                        {failed}
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                id: 'queue',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    Queue
                    {queued ? <span className="tabular text-muted">{queued}</span> : null}
                  </span>
                ),
              },
            ]}
          />
          {segment === 'all' ? (
            <FilterButton
              label="Status"
              single
              options={jobStatuses.map((id) => ({ id, label: jobStatusLabel(id) }))}
              value={filter.status ? [filter.status] : []}
              onChange={(value) => set({ status: value[0] })}
            />
          ) : null}
          <FilterButton
            label="Analyzer"
            single
            options={(analyzers.data?.analyzers ?? []).map((analyzer) => ({
              id: analyzer.kind,
              label: analyzer.label,
            }))}
            value={search.analyzer ? [search.analyzer] : []}
            onChange={(value) => set({ analyzer: value[0] })}
          />
          <FilterButton
            label="Repository"
            single
            options={(targets.data?.targets ?? []).map((target) => ({
              id: target.repo,
              label: target.group !== undefined ? `group ${target.group}` : target.repo,
            }))}
            value={search.repo ? [search.repo] : []}
            onChange={(value) => set({ repo: value[0] })}
          />
          <FilterButton
            label="Trigger"
            single
            options={jobTriggers.map((id) => ({ id, label: jobTriggerLabel(id) }))}
            value={filter.trigger ? [filter.trigger] : []}
            onChange={(value) => set({ trigger: value[0] })}
          />
          {search.schedule ? (
            <FilterChip label="Remove schedule filter" onClear={() => set({ schedule: undefined })}>
              Schedule <b className="mono">{search.schedule}</b>
            </FilterChip>
          ) : null}
          {search.signature ? (
            <FilterChip label="Remove failure filter" onClear={() => set({ signature: undefined })}>
              Failure
              <b className="mono max-w-80 truncate" title={search.signature}>
                {search.signature}
              </b>
            </FilterChip>
          ) : null}
        </>
      }
    >
      <div className="-m-4 flex flex-col text-[13px]">
        {stats.data ? (
          <QueueHealth
            stats={stats.data}
            now={now}
            {...(segment !== 'queue' && { onQueue: () => setSegment('queue') })}
          />
        ) : null}

        {targets.isError ? (
          <ErrorState error={targets.error} />
        ) : nothingInScope ? (
          <EmptyState
            icon={<ListChecks />}
            title="No repositories here"
            description="Switch the scope to see runs of other repositories."
          />
        ) : (
          <>
            <header className="flex flex-wrap items-center gap-3 px-3.5 py-3">
              <h2 className="text-[13px] font-semibold">
                {segment === 'failures' ? 'Failures' : segment === 'queue' ? 'Queue' : 'Runs'}
                <span className="ms-2 text-xs font-normal text-muted">
                  {segmentCaptions[segment]} · {view === 'mine' ? 'My teams' : 'All I can see'}
                </span>
              </h2>
              <span className="flex-1" />
              <Legend label="Run statuses" items={statusLegend} />
            </header>
            {!ready || jobs.isPending ? (
              <div className="flex flex-col gap-1 px-3.5 pb-3">
                {Array.from({ length: 8 }, (_, i) => (
                  <Placeholder key={i} className="h-7" />
                ))}
              </div>
            ) : jobs.isError ? (
              <ErrorState error={jobs.error} />
            ) : list.length === 0 ? (
              <EmptyState
                icon={<ListChecks />}
                title={segment === 'queue' ? 'Nothing queued' : 'No runs'}
                description={
                  segment === 'queue'
                    ? 'Every due run has a worker.'
                    : 'Schedules, triggers and manual runs queue analyzer runs here. Loosen the filters to see more.'
                }
              />
            ) : (
              <Table label="Runs">
                <thead>
                  <tr>
                    <Th>Status</Th>
                    <Th>Analyzer</Th>
                    <Th>Repository · ref</Th>
                    <Th>Trigger</Th>
                    <Th align="right">Duration</Th>
                    <Th align="right">Tries</Th>
                    <Th align="right">Cost</Th>
                    <Th sorted="descending">Started</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((job) => {
                    const wait = waits[job.id]
                    const cost = costs[job.id]
                    return (
                      <RunRow
                        key={job.id}
                        job={job}
                        labelOf={labelOf}
                        {...(job.actor && { person: personOf(people, job.actor) })}
                        {...(wait && { wait })}
                        {...(cost !== undefined && { costUsd: cost })}
                        selected={job.id === openId}
                        now={now}
                        onOpen={() => setOpenId(job.id)}
                      />
                    )
                  })}
                </tbody>
              </Table>
            )}
            {jobs.isSuccess && list.length ? (
              <ListFooter
                shown={list.length}
                total={Math.max(jobCount.data?.total ?? 0, list.length)}
                noun="runs"
                more={
                  jobs.hasNextPage ? (
                    <LoadMore
                      variant="ghost"
                      size="sm"
                      onLoad={() => void jobs.fetchNextPage()}
                      isPending={jobs.isFetchingNextPage}
                    >
                      Load older
                    </LoadMore>
                  ) : undefined
                }
                hints={
                  <>
                    Navigate <Kbd>J</Kbd>
                    <Kbd>K</Kbd>
                  </>
                }
              />
            ) : null}
            {segment === 'queue' ? null : (
              <RecurringFailures
                failures={failures}
                range={range}
                onRange={setRange}
                labelOf={labelOf}
                now={now}
                onShow={(group) =>
                  set({
                    view: 'failures',
                    status: undefined,
                    analyzer: group.analyzer,
                    signature: group.errorSignature || undefined,
                  })
                }
                onLatest={setOpenId}
                {...(segment === 'all' && { onAll: () => setSegment('failures') })}
              />
            )}
          </>
        )}
      </div>

      {openId === undefined ? null : (
        <RunSheet
          jobId={openId}
          job={openJob}
          label={openJob ? labelOf(openJob.analyzer) : 'Run'}
          {...(costs[openId] !== undefined && { costUsd: costs[openId] })}
          {...(opened.isError && { error: opened.error })}
          onClose={() => setOpenId(undefined)}
          {...(index >= 0 && { index, total: list.length })}
          {...(index > 0 && { onPrevious: () => setOpenId(list[index - 1]?.id) })}
          {...(index >= 0 &&
            index < list.length - 1 && { onNext: () => setOpenId(list[index + 1]?.id) })}
        />
      )}
      {run.dialog}
    </Page>
  )
}
