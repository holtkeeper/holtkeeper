import type { Block, CiJobsData, CiProblem, CiProblemKind, RepoRef } from '@holtkeeper/api'
import { Link, useParams } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, ExternalLink, Timer } from 'lucide-react'
import { useState } from 'react'

import { useCiRepo } from '../../api/queries.ts'
import {
  changeLabel,
  failureTone,
  problemTones,
  seconds,
  stageColumns,
  successTone,
  unreliableJobs,
} from '../../lib/ci.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import { parseRepoKey } from '../../lib/repo.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  Page,
  Placeholder,
  SegmentBar,
  Table,
  Tag,
  Td,
  Th,
} from '../../ui/index.ts'
import { MiniSparkline } from '../../ui/MiniSparkline.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { BlockView } from '../reports/BlockView.tsx'
import { RepoAvatar } from '../repos/RepoAvatar.tsx'
import { Figure, toneBox } from './parts.tsx'

function PipelinePicture({
  data,
  flags,
}: {
  data: CiJobsData
  flags: Record<string, CiProblemKind[]>
}) {
  const columns = stageColumns(data, flags)
  return (
    <section className="rounded-xl border border-line bg-panel p-3.5">
      <h2 className="mb-3 text-sm font-semibold">Pipeline</h2>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {columns.map((column) => (
          <div key={column.stage} className="flex w-44 shrink-0 flex-col gap-1.5">
            <span className="mono truncate text-xs text-muted" title={column.stage}>
              {column.stage}
            </span>
            {column.jobs.map((job) => (
              <a
                key={job.name}
                href={job.href}
                target="_blank"
                rel="noreferrer"
                className="flex flex-col gap-1 rounded-[7px] border px-2 py-1.5 hover:brightness-110"
                style={toneBox(job.tone)}
                title={`${job.name}: median ${seconds(job.median)}${job.failureRate === undefined ? '' : `, fails in ${job.failureRate}%`}${job.allowFailure ? ', allowed to fail' : ''}`}
              >
                <span className="mono truncate text-xs">{job.name}</span>
                <span className="flex flex-wrap items-center gap-1">
                  <span className="tabular text-xs text-muted">{seconds(job.median)}</span>
                  {job.flags.map((flag) => (
                    <Tag key={flag} tone={problemTones[flag]} className="!px-1 !py-0 text-[10px]">
                      {flag}
                    </Tag>
                  ))}
                </span>
              </a>
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}

function Figures({ data }: { data: CiJobsData }) {
  const { pipelines } = data
  const change = changeLabel(pipelines.change)
  const scope = pipelines.ref ? `on ${pipelines.ref}` : 'on every branch'
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Figure
        label="Pipeline time"
        value={
          <span className="inline-flex items-baseline gap-2">
            {seconds(pipelines.duration.median)}
            {change.text ? (
              <Tag tone={change.tone} mono title="Median of the last 7 days against the 7 before">
                {change.text}
              </Tag>
            ) : null}
          </span>
        }
        hint={`p90 ${seconds(pipelines.duration.p90)} · passing pipelines ${scope}`}
      />
      <Figure
        label="Success rate"
        value={pipelines.successRate === undefined ? '—' : `${pipelines.successRate}%`}
        hint={`${plural(pipelines.count, 'pipeline')} ${scope}`}
      >
        {pipelines.successRate === undefined ? null : (
          <SegmentBar
            segments={[
              {
                value: pipelines.successRate,
                tone: successTone(pipelines.successRate),
                label: '% passed',
              },
              {
                value: Math.round((100 - pipelines.successRate) * 10) / 10,
                tone: 'danger',
                label: '% failed',
              },
            ]}
          />
        )}
      </Figure>
      <Figure
        label="Queue time"
        value={seconds(pipelines.queue.median)}
        hint={`p90 ${seconds(pipelines.queue.p90)} waiting for a runner`}
      />
    </div>
  )
}

const weekLabel = (week: string) =>
  new Date(`${week}T00:00:00Z`).toLocaleDateString('en', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })

function PipelineTimeChart({ data }: { data: CiJobsData }) {
  const block: Block = {
    type: 'chart',
    title: 'Pipeline time per week',
    chart: 'line',
    unit: 'ms',
    x: 'week',
    series: [
      { key: 'median', label: 'Median', tone: 'info' },
      { key: 'p90', label: 'p90', tone: 'warning', dashed: true },
    ],
    data: data.weeks.map((week) => ({
      week: weekLabel(week.week),
      median: week.median === undefined ? null : Math.round(week.median * 1000),
      p90: week.p90 === undefined ? null : Math.round(week.p90 * 1000),
    })),
  }
  return (
    <section className="rounded-xl border border-line bg-panel p-3.5">
      <BlockView block={block} />
    </section>
  )
}

function Problems({ problems }: { problems: CiProblem[] }) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <h2 className="px-3.5 pt-3 text-sm font-semibold">Problem jobs</h2>
      {problems.length ? (
        <ul className="divide-y divide-[var(--line)]">
          {problems.map((problem) => (
            <li
              key={`${problem.kind}:${problem.job}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5"
            >
              <Tag tone={problemTones[problem.kind]} dot>
                {problem.kind}
              </Tag>
              <span className="mono text-sm">{problem.job}</span>
              <span className="mono text-xs text-dim">{problem.stage}</span>
              <span className="text-sm text-muted">{problem.reason}</span>
              <a
                href={problem.href}
                target="_blank"
                rel="noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
              >
                Open run
                <ExternalLink className="size-3" />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3.5 py-3 text-sm text-muted">
          No job got slower, keeps failing or passes only on retry.
        </p>
      )}
    </section>
  )
}

function Details({ data }: { data: CiJobsData }) {
  const unreliable = unreliableJobs(data.jobs)
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-line bg-panel">
        <h2 className="px-3.5 pt-3 text-sm font-semibold">Jobs</h2>
        <Table label="Jobs">
          <thead>
            <tr>
              <Th>Job</Th>
              <Th>Stage</Th>
              <Th align="right">Runs</Th>
              <Th>Median per week</Th>
              <Th align="right">Median</Th>
              <Th align="right">p90</Th>
              <Th align="right">Recent change</Th>
              <Th align="right">Failure rate</Th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((job) => {
              const change = changeLabel(job.change)
              return (
                <tr key={job.name}>
                  <Td>
                    <a
                      href={job.last.href}
                      target="_blank"
                      rel="noreferrer"
                      className="mono hover:underline"
                    >
                      {job.name}
                    </a>
                    {job.allowFailure ? (
                      <span className="ml-2 text-xs text-dim">allowed to fail</span>
                    ) : null}
                  </Td>
                  <Td className="mono text-xs text-muted">{job.stage}</Td>
                  <Td align="right" className="tabular">
                    {job.runs}
                  </Td>
                  <Td className="w-32">
                    <MiniSparkline
                      values={job.weeks}
                      color="var(--info)"
                      label={`Median of ${job.name} per week`}
                      className="h-6 w-28"
                    />
                  </Td>
                  <Td align="right" className="tabular">
                    {seconds(job.duration.median)}
                  </Td>
                  <Td align="right" className="tabular text-muted">
                    {seconds(job.duration.p90)}
                  </Td>
                  <Td align="right">
                    {change.text ? (
                      <Tag tone={change.tone} mono>
                        {change.text}
                      </Tag>
                    ) : null}
                  </Td>
                  <Td align="right" className="tabular">
                    {job.failureRate === undefined ? '—' : `${job.failureRate}%`}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      </section>
      <section className="rounded-xl border border-line bg-panel">
        <h2 className="px-3.5 pt-3 text-sm font-semibold">Reliability</h2>
        {unreliable.length ? (
          <Table label="Reliability">
            <thead>
              <tr>
                <Th>Job</Th>
                <Th align="right">Failure rate</Th>
                <Th align="right">Failures</Th>
                <Th align="right">Passed on retry</Th>
                <Th align="right">Retried</Th>
              </tr>
            </thead>
            <tbody>
              {unreliable.map((job) => (
                <tr key={job.name}>
                  <Td className="mono">{job.name}</Td>
                  <Td align="right">
                    <Tag tone={failureTone(job.failureRate)} mono>
                      {job.failureRate ?? 0}%
                    </Tag>
                  </Td>
                  <Td align="right" className="tabular">
                    {job.failures}
                  </Td>
                  <Td align="right" className="tabular">
                    {job.flaky}
                  </Td>
                  <Td align="right" className="tabular">
                    {job.retryRate}%
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="px-3.5 py-3 text-sm text-muted">
            No job failed or needed a retry to pass in the window.
          </p>
        )}
      </section>
    </div>
  )
}

function Empty({ repo, outdated }: { repo: RepoRef; outdated: boolean }) {
  return (
    <EmptyState
      icon={<Timer />}
      title={outdated ? 'Waiting for the next run' : 'No CI data yet'}
      description={
        outdated
          ? 'The newest record was written by an earlier version; the next daily freshness run replaces it.'
          : 'The ci-jobs analyzer reads pipelines every night.'
      }
      action={<RunJobButton repo={repo} analyzer="ci-jobs" label="Run now" variant="secondary" />}
    />
  )
}

/**
 * One repository's CI from its newest record: the pipeline as stages of jobs, pipeline time,
 * success rate and queue, weekly pipeline time and the problem jobs; tables behind Details.
 */
export function CiRepoPage() {
  const { _splat: key } = useParams({ strict: false })
  const repo = parseRepoKey(key)
  const view = useCiRepo(repo)
  const [details, setDetails] = useState(false)

  if (!repo)
    return (
      <EmptyState
        title="No repository"
        description={
          <>
            Open a repository from <Link to="/ci">CI</Link>.
          </>
        }
      />
    )
  const data = view.data?.data
  return (
    <Page
      title={repo.path}
      eyebrow={<Link to="/ci">CI</Link>}
      media={<RepoAvatar repo={repo} size="lg" />}
      description={
        data && view.data?.createdAt
          ? `Last ${data.window.days} days · read ${formatRelative(view.data.createdAt)}`
          : undefined
      }
    >
      {view.isPending ? (
        <div className="flex flex-col gap-3">
          <Placeholder className="h-40" />
          <Placeholder className="h-24" />
        </div>
      ) : view.isError ? (
        <ErrorState error={view.error} />
      ) : !data ? (
        <Empty repo={repo} outdated={view.data.analysisId !== undefined} />
      ) : (
        <>
          <PipelinePicture data={data} flags={view.data.flags} />
          <Figures data={data} />
          <PipelineTimeChart data={data} />
          <Problems problems={view.data.problems} />
          <div>
            <Button variant="ghost" size="sm" onPress={() => setDetails(!details)}>
              {details ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Details
            </Button>
          </div>
          {details ? <Details data={data} /> : null}
        </>
      )}
    </Page>
  )
}
