import type { CiFleetJobRow, CiFleetJobSort } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { useCiFleetJobs } from '../../api/queries.ts'
import { changeLabel, failureTone, problemLabel, problemTones, seconds } from '../../lib/ci.ts'
import { plural } from '../../lib/format.ts'
import { repoKey, repoSplat } from '../../lib/repo.ts'
import { statusColor } from '../../ui/colors.ts'
import {
  ErrorState,
  type FleetColumn,
  FleetTable,
  Placeholder,
  SegmentedTabs,
  Tag,
} from '../../ui/index.ts'

type Row = CiFleetJobRow & { groups: readonly string[] }

const sorts: readonly { id: CiFleetJobSort; label: string }[] = [
  { id: 'slowest', label: 'Slowest' },
  { id: 'unreliable', label: 'Least reliable' },
  { id: 'slower', label: 'Got slower' },
]

const columns: readonly FleetColumn<Row>[] = [
  {
    id: 'job',
    header: 'Job',
    cell: (job) => (
      <span className="flex flex-wrap items-center gap-1">
        <span className="mono text-[12.5px]">{job.name}</span>
        {job.problems.map((kind) => (
          <Tag key={kind} tone={problemTones[kind]} className="!px-1 !py-0 text-[10px]">
            {problemLabel[kind]}
          </Tag>
        ))}
      </span>
    ),
  },
  {
    id: 'repo',
    header: 'Repository',
    cell: (job) => (
      <Link
        to="/repos/$"
        params={{ _splat: repoSplat(job.repo) }}
        search={{ tab: 'quality', section: 'ci' }}
        className="mono text-[12.5px] hover:underline"
      >
        {job.repo.path}
      </Link>
    ),
  },
  {
    id: 'stage',
    header: 'Stage',
    cell: (job) => <span className="mono text-xs">{job.stage}</span>,
  },
  { id: 'median', header: 'Median', align: 'right', cell: (job) => seconds(job.median) },
  { id: 'p90', header: 'p90', align: 'right', cell: (job) => seconds(job.p90) },
  {
    id: 'change',
    header: 'Change',
    align: 'right',
    cell: (job) => {
      const change = changeLabel(job.change)
      return change.text ? (
        <Tag tone={change.tone} mono>
          {change.text}
        </Tag>
      ) : null
    },
  },
  {
    id: 'failure',
    header: 'Failure rate',
    align: 'right',
    cell: (job) =>
      job.failureRate === undefined ? (
        '—'
      ) : (
        <span style={{ color: statusColor[failureTone(job.failureRate)] }}>{job.failureRate}%</span>
      ),
  },
  { id: 'retry', header: 'Passed on retry', align: 'right', cell: (job) => job.flaky },
  { id: 'runs', header: 'Runs', align: 'right', cell: (job) => job.runs },
  {
    id: 'run',
    header: 'Run',
    cell: (job) =>
      job.last ? (
        <a
          href={job.last.href}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted hover:text-foreground"
        >
          Last run
        </a>
      ) : null,
  },
]

/**
 * The worst CI jobs across the readable repositories from `GET /api/ci/jobs/fleet`, switched
 * between slowest, least reliable and got slower; `groupsOf` gives each repository's groups for
 * the scope switch's folding.
 */
export function CiFleetJobs({
  groupsOf,
  scope,
}: {
  groupsOf: (repo: string) => readonly string[]
  scope: Parameters<typeof FleetTable>[0]['scope']
}) {
  const [sort, setSort] = useState<CiFleetJobSort>('slowest')
  const jobs = useCiFleetJobs(sort)
  if (jobs.isPending) return <Placeholder className="h-48" />
  if (jobs.isError) return <ErrorState error={jobs.error} />
  const rows: Row[] = jobs.data.jobs.map((job) => ({ ...job, groups: groupsOf(repoKey(job.repo)) }))
  return (
    <section aria-label="Jobs across repositories" className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold">
        {sorts.find((each) => each.id === sort)?.label} jobs across{' '}
        {plural(jobs.data.repos, 'repository', 'repositories')}
      </h2>
      <FleetTable<Row>
        label="Jobs across repositories"
        rows={rows}
        rowKey={(job) => `${repoKey(job.repo)}\0${job.stage}\0${job.name}`}
        columns={columns}
        {...(scope ? { scope } : {})}
        toolbar={
          <SegmentedTabs
            aria-label="Rank jobs by"
            items={sorts}
            selected={sort}
            onSelect={(id) => setSort(sorts.find((each) => each.id === id)?.id ?? 'slowest')}
          />
        }
        noun={{ one: 'job', many: 'jobs' }}
        caption={`of ${jobs.data.total.toLocaleString('en')} · read nightly`}
        empty={<p className="text-sm text-muted">No job fits this ranking.</p>}
      />
    </section>
  )
}
