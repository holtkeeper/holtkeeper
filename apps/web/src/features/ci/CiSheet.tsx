import type { Block, CiJobsData, CiRepoCard, CiRepoView, RepoRef } from '@holtkeeper/api'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { ExternalLink, FolderGit2, RefreshCw, ShieldCheck, Timer } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useCiJobs, useCiRepo } from '../../api/queries.ts'
import {
  changeLabel,
  ciStatusLabel,
  ciStatusTone,
  failureTone,
  moreFlagged,
  outcomeBar,
  problemLabel,
  problemTones,
  releaseGateText,
  seconds,
  stageBars,
  unreliableJobs,
} from '../../lib/ci.ts'
import { formatDateTime, formatDayLabel, formatRelative, plural } from '../../lib/format.ts'
import { repoKey, repoSplat } from '../../lib/repo.ts'
import { statusColor } from '../../ui/colors.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  KeyValue,
  Placeholder,
  SideSheet,
  Table,
  Tag,
  Td,
  Th,
} from '../../ui/index.ts'
import { RunJobButton, useRunJob } from '../jobs/RunJobDialog.tsx'
import { BlockView } from '../reports/BlockView.tsx'

/** Tabs of a repository's CI, in order. */
export type CiTab = 'overview' | 'jobs' | 'problems' | 'reliability'

/** `id` as a CI tab; unknown ids fall back to Overview. */
export const ciTabOf = (id: string): CiTab =>
  id === 'jobs' || id === 'problems' || id === 'reliability' ? id : 'overview'

/** The tab bar entries of a repository's CI with their counts. */
export const ciTabItems = (view: CiRepoView) => [
  { id: 'overview', label: 'Overview' },
  { id: 'jobs', label: 'Jobs', badge: view.data?.jobs.length ?? 0 },
  { id: 'problems', label: 'Problems', badge: Object.keys(view.flags).length },
  { id: 'reliability', label: 'Reliability' },
]

const Section = ({
  title,
  aside,
  children,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}) => (
  <section className="flex flex-col gap-2">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-xs font-semibold text-muted">{title}</h3>
      {aside}
    </div>
    {children}
  </section>
)

const RunLink = ({ href, label = 'Open run' }: { href: string; label?: string }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex shrink-0 items-center gap-1 text-xs text-muted hover:text-foreground"
  >
    {label}
    <ExternalLink className="size-3" />
  </a>
)

function DurationBars({ view, data }: { view: CiRepoView; data: CiJobsData }) {
  const bars = stageBars(data, view.flags)
  if (!bars.length) return <p className="text-sm text-muted">No job ran in the window.</p>
  return (
    <div role="list" aria-label="Job duration by stage" className="flex flex-col gap-1">
      {bars.map((bar) => (
        <div
          role="listitem"
          key={`${bar.stage}:${bar.job}`}
          aria-label={`${bar.job}: median ${seconds(bar.median)}, p90 ${seconds(bar.p90)}${bar.flags.length ? `, ${bar.flags.join(', ')}` : ''}`}
          className={`grid grid-cols-[72px_minmax(0,140px)_minmax(0,1fr)_auto] items-center gap-2 text-xs ${bar.first ? 'mt-1.5 first:mt-0' : ''}`}
        >
          <span className="mono truncate text-dim" title={bar.stage}>
            {bar.first ? bar.stage : ''}
          </span>
          <span className="mono flex min-w-0 items-center gap-1" title={bar.job}>
            <span className="truncate">{bar.job}</span>
            {bar.flags.map((flag) => (
              <Tag key={flag} tone={problemTones[flag]} className="!px-1 !py-0 text-[10px]">
                {problemLabel[flag]}
              </Tag>
            ))}
          </span>
          <span aria-hidden className="relative h-2 rounded-full bg-raise">
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                width: `${bar.p90Width}%`,
                background: `color-mix(in srgb, ${statusColor[bar.flags.length ? 'warning' : 'info']} 30%, transparent)`,
              }}
            />
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                width: `${bar.medianWidth}%`,
                background: statusColor[bar.flags.length ? 'warning' : 'info'],
              }}
            />
          </span>
          <span className="tabular whitespace-nowrap text-muted">
            <span className="text-foreground">{seconds(bar.median)}</span> / {seconds(bar.p90)}
          </span>
        </div>
      ))}
    </div>
  )
}

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
      week: formatDayLabel(week.week),
      median: week.median === undefined ? null : Math.round(week.median * 1000),
      p90: week.p90 === undefined ? null : Math.round(week.p90 * 1000),
    })),
  }
  return <BlockView block={block} />
}

function ProblemList({ view, limit }: { view: CiRepoView; limit?: number }) {
  const problems = limit === undefined ? view.problems : view.problems.slice(0, limit)
  if (!problems.length)
    return (
      <p className="text-sm text-muted">
        No job got slower, keeps failing or passes only on retry.
      </p>
    )
  return (
    <ul className="flex flex-col divide-y divide-[var(--line)] rounded-[7px] border border-line">
      {problems.map((problem) => (
        <li key={`${problem.kind}:${problem.job}`} className="flex flex-col gap-1 px-3 py-2">
          <span className="flex flex-wrap items-center gap-2">
            <Tag tone={problemTones[problem.kind]} dot>
              {problemLabel[problem.kind]}
            </Tag>
            <span className="mono text-[12.5px]">{problem.job}</span>
            <span className="mono text-[11px] text-dim">{problem.stage}</span>
            <span className="ms-auto">
              <RunLink href={problem.href} />
            </span>
          </span>
          <span className="text-xs text-muted">{problem.reason}</span>
        </li>
      ))}
    </ul>
  )
}

function Overview({
  view,
  data,
  card,
  onTab,
}: {
  view: CiRepoView
  data: CiJobsData
  card: CiRepoCard | undefined
  onTab: (tab: CiTab) => void
}) {
  const { pipelines } = data
  const change = changeLabel(pipelines.change)
  const ref = pipelines.ref
  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Job duration by stage"
        aside={<span className="text-[11px] text-dim">median / p90</span>}
      >
        <DurationBars view={view} data={data} />
      </Section>
      <Section
        title={`Problem jobs · ${view.problems.length}`}
        aside={
          <Button variant="ghost" size="sm" onPress={() => onTab('jobs')}>
            All jobs
          </Button>
        }
      >
        <ProblemList view={view} />
      </Section>
      <Section title="Pipeline">
        <KeyValue
          rows={[
            {
              label: 'Pipeline time',
              value: (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="mono">{seconds(pipelines.duration.median)}</span>
                  {change.text ? (
                    <Tag tone={change.tone} mono title="Last 7 days against the 7 before">
                      {change.text}
                    </Tag>
                  ) : null}
                </span>
              ),
            },
            {
              label: 'p90',
              value: (
                <span>
                  <span className="mono">{seconds(pipelines.duration.p90)}</span>
                  <span className="text-muted">
                    {' '}
                    · passing pipelines {ref ? `on ${ref}` : 'on every branch'}
                  </span>
                </span>
              ),
            },
            {
              label: 'Queue time',
              value: (
                <span>
                  <span className="mono">{seconds(pipelines.queue.median)}</span>
                  <span className="text-muted">
                    {' '}
                    · p90 {seconds(pipelines.queue.p90)} waiting for a runner
                  </span>
                </span>
              ),
            },
            {
              label: 'Window',
              value: (
                <span>
                  {data.window.days} days
                  {ref ? (
                    <>
                      {' '}
                      · <span className="mono">{ref}</span>
                    </>
                  ) : null}
                </span>
              ),
            },
            {
              label: 'Read',
              value: view.createdAt ? (
                <span title={formatDateTime(view.createdAt)}>{formatRelative(view.createdAt)}</span>
              ) : null,
            },
            {
              label: 'Release gate',
              value: card?.releaseGate ? releaseGateText(card.releaseGate) : null,
            },
          ]}
        />
      </Section>
      <Section title="Pipeline time per week">
        <PipelineTimeChart data={data} />
      </Section>
    </div>
  )
}

function Jobs({ repo }: { repo: RepoRef }) {
  const jobs = useCiJobs(repo)
  if (jobs.isPending) return <Placeholder className="h-40" />
  if (jobs.isError) return <ErrorState error={jobs.error} />
  const { jobs: rows, total, range } = jobs.data
  if (!rows.length) return <p className="text-sm text-muted">No job ran in the window.</p>
  return (
    <div className="flex flex-col gap-2">
      <Table label="Jobs">
        <thead>
          <tr>
            <Th>Job</Th>
            <Th align="right">Median</Th>
            <Th align="right">p90</Th>
            <Th align="right">Change</Th>
            <Th align="right">Failure rate</Th>
            <Th align="right">Passed on retry</Th>
            <Th align="right">Runs</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((job) => {
            const change = changeLabel(job.change)
            return (
              <tr key={`${job.stage}:${job.name}`}>
                <Td>
                  <div className="flex min-w-0 flex-col leading-tight">
                    <span className="flex flex-wrap items-center gap-1">
                      {job.last ? (
                        <a
                          href={job.last.href}
                          target="_blank"
                          rel="noreferrer"
                          className="mono text-[12.5px] hover:underline"
                        >
                          {job.name}
                        </a>
                      ) : (
                        <span className="mono text-[12.5px]">{job.name}</span>
                      )}
                      {job.problems.map((kind) => (
                        <Tag
                          key={kind}
                          tone={problemTones[kind]}
                          className="!px-1 !py-0 text-[10px]"
                        >
                          {problemLabel[kind]}
                        </Tag>
                      ))}
                    </span>
                    <span className="mono text-[11px] text-dim">
                      {job.stage}
                      {job.allowFailure ? ' · allowed to fail' : ''}
                    </span>
                  </div>
                </Td>
                <Td align="right" className="tabular">
                  {seconds(job.median)}
                </Td>
                <Td align="right" className="tabular text-muted">
                  {seconds(job.p90)}
                </Td>
                <Td align="right">
                  {change.text ? (
                    <Tag tone={change.tone} mono>
                      {change.text}
                    </Tag>
                  ) : null}
                </Td>
                <Td align="right" className="tabular">
                  {job.failureRate === undefined ? (
                    '—'
                  ) : (
                    <span style={{ color: statusColor[failureTone(job.failureRate)] }}>
                      {job.failureRate}%
                    </span>
                  )}
                </Td>
                <Td align="right" className="tabular">
                  {job.flaky}
                </Td>
                <Td align="right" className="tabular">
                  {job.runs}
                </Td>
              </tr>
            )
          })}
        </tbody>
      </Table>
      <p className="text-xs text-muted">
        Showing {rows.length} of {plural(total, 'job')} · {formatRelative(range.from)} to{' '}
        {formatRelative(range.to)}
      </p>
    </div>
  )
}

function Problems({ view }: { view: CiRepoView }) {
  const more = moreFlagged(view.flags, view.problems)
  return (
    <div className="flex flex-col gap-5">
      <Section title="Problem jobs">
        <ProblemList view={view} />
      </Section>
      {more.length ? (
        <Section title="Also flagged">
          <ul className="flex flex-col gap-1.5">
            {more.map((entry) => (
              <li key={entry.job} className="flex flex-wrap items-center gap-2">
                <span className="mono text-[12.5px]">{entry.job}</span>
                {entry.kinds.map((kind) => (
                  <Tag key={kind} tone={problemTones[kind]} dot>
                    {problemLabel[kind]}
                  </Tag>
                ))}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}

function Reliability({ data }: { data: CiJobsData }) {
  const unreliable = unreliableJobs(data.jobs)
  if (!unreliable.length)
    return (
      <p className="text-sm text-muted">No job failed or needed a retry to pass in the window.</p>
    )
  return (
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
          <tr key={`${job.stage}:${job.name}`}>
            <Td className="mono text-[12.5px]">{job.name}</Td>
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
  )
}

/** The line under a CI header: state, groups, branch, pipeline count and the newest run. */
export function CiSummary({ view, card }: { view: CiRepoView; card: CiRepoCard | undefined }) {
  const data = view.data
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      {card ? (
        <Tag tone={ciStatusTone[card.status]} dot>
          {ciStatusLabel[card.status]}
        </Tag>
      ) : null}
      {card?.groups.map((group) => (
        <Tag key={group}>{group}</Tag>
      ))}
      {data?.pipelines.ref ? <span className="mono">{data.pipelines.ref}</span> : null}
      {data ? (
        <span>
          · {plural(data.pipelines.count, 'pipeline')} in {data.window.days} days
        </span>
      ) : null}
      {data?.lastRunAt ? (
        <span title={formatDateTime(data.lastRunAt)}>· last {formatRelative(data.lastRunAt)}</span>
      ) : null}
    </div>
  )
}

/**
 * The body of one CI tab of `repo` from its newest record: Overview (job duration by stage,
 * problem jobs, pipeline numbers with the release gate when `card` carries it, pipeline time per
 * week), Jobs (`GET /api/ci/jobs`), Problems or Reliability. Says so, with Run now, while the
 * repository has no record in the current format.
 */
export function CiTabBody({
  repo,
  view,
  card,
  tab,
  onTab,
}: {
  repo: RepoRef
  view: CiRepoView
  card: CiRepoCard | undefined
  tab: CiTab
  onTab: (tab: CiTab) => void
}) {
  const data = view.data
  if (!data)
    return (
      <EmptyState
        icon={<Timer />}
        title={view.analysisId ? 'Waiting for the next run' : 'No CI data yet'}
        description={
          view.analysisId
            ? 'The newest record was written by an earlier version; the next freshness run replaces it.'
            : 'The ci-jobs analyzer reads pipelines every night.'
        }
        action={<RunJobButton repo={repo} analyzer="ci-jobs" label="Run now" variant="secondary" />}
      />
    )
  if (tab === 'jobs') return <Jobs repo={repo} />
  if (tab === 'problems') return <Problems view={view} />
  if (tab === 'reliability') return <Reliability data={data} />
  return <Overview view={view} data={data} card={card} onTab={onTab} />
}

/**
 * One repository's CI in a side sheet: its state and pipeline outcomes as the progress bar, Re-read
 * pipelines and, when the card names a release gate, Release gates, then the Overview, Jobs,
 * Problems and Reliability tabs. `card` is the repository's row on the CI table. Closed while
 * `repo` is unset.
 */
export function CiSheet({
  repo,
  card,
  onClose,
  index,
  total,
  onPrevious,
  onNext,
}: {
  repo: RepoRef | undefined
  card: CiRepoCard | undefined
  onClose: () => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const router = useRouter()
  const navigate = useNavigate()
  const view = useCiRepo(repo)
  const run = useRunJob({ repo, analyzer: 'ci-jobs', label: 'Re-read pipelines' })
  const [tab, setTab] = useState<CiTab>('overview')
  const bar = outcomeBar(view.data?.data?.pipelines.outcomes)
  const reread = run.action?.onPress
    ? { label: 'Re-read pipelines', icon: RefreshCw, onPress: run.action.onPress }
    : undefined
  const gates =
    repo && card?.releaseGate
      ? {
          label: 'Release gates',
          icon: ShieldCheck,
          onPress: () => void navigate({ to: '/releases/setup', search: { repo: repoKey(repo) } }),
        }
      : undefined
  const quiet = [reread, gates].filter((action) => action !== undefined)
  const analysisId = view.data?.analysisId
  return (
    <>
      <SideSheet
        open={repo !== undefined}
        onClose={onClose}
        title={repo?.path ?? 'CI'}
        {...(repo ? { id: repo.forge } : {})}
        {...(bar ? { progress: bar } : {})}
        {...(index !== undefined && total !== undefined ? { index, total } : {})}
        {...(onPrevious ? { onPrevious } : {})}
        {...(onNext ? { onNext } : {})}
        {...(quiet[0]
          ? { quietActions: quiet[1] ? ([quiet[0], quiet[1]] as const) : ([quiet[0]] as const) }
          : {})}
        {...(analysisId
          ? { openAsPage: { to: '/analyses/$id', params: { id: analysisId }, search: {} } }
          : {})}
        {...(repo
          ? {
              more: [
                {
                  label: 'Open repository',
                  icon: FolderGit2,
                  href: router.buildLocation({
                    to: '/repos/$',
                    params: { _splat: repoSplat(repo) },
                    search: { tab: 'quality', section: 'ci' },
                  }).href,
                },
              ],
            }
          : {})}
        {...(view.data?.data
          ? {
              tabs: {
                items: ciTabItems(view.data),
                selected: tab,
                onSelect: (id: string) => setTab(ciTabOf(id)),
                'aria-label': 'CI sections',
              },
            }
          : {})}
      >
        {!repo ? null : view.isPending ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Placeholder key={i} className="h-16" />
            ))}
          </div>
        ) : view.isError ? (
          <ErrorState error={view.error} />
        ) : (
          <div className="flex flex-col gap-4">
            <CiSummary view={view.data} card={card} />
            <CiTabBody repo={repo} view={view.data} card={card} tab={tab} onTab={setTab} />
          </div>
        )}
      </SideSheet>
      {run.dialog}
    </>
  )
}
