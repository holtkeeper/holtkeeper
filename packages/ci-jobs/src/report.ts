import type { RepoRef } from '@holtkeeper/forge'
import { defineAnalysis, metric } from '@holtkeeper/report'
import type {
  Block,
  Cell,
  HeatmapRow,
  Issue,
  Metric,
  Report,
  Section,
  Tone,
} from '@holtkeeper/report'

import { ciJobsDataSchema } from './schema.ts'
import { formatDuration, round, weekOf } from './stats.ts'
import type { CiJobsData, JobStats, JobTrend, RefGroupStats } from './types.ts'

/** Slowdowns that get a chart of their own. */
const CHARTED_SLOWDOWNS = 3
/** Jobs in the heatmaps, by compute time. */
const HEATMAP_JOBS = 25
/** Jobs in the jobs table, by compute time. */
const TABLE_JOBS = 100

const ms = (seconds: number | undefined) =>
  seconds === undefined ? undefined : Math.round(seconds * 1000)

const weekLabel = (week: string) =>
  new Date(`${week}T00:00:00Z`).toLocaleDateString('en', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })

const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value)}%`

const shortSha = (sha: string | undefined) => (sha ? sha.slice(0, 8) : undefined)

const failureTone = (rate: number | undefined): Tone =>
  rate === undefined ? 'neutral' : rate < 5 ? 'good' : rate < 15 ? 'warning' : 'bad'

const TREND_TONE: Record<JobTrend, Tone> = {
  slower: 'bad',
  faster: 'good',
  stable: 'neutral',
  new: 'info',
  idle: 'neutral',
}

function measured(
  id: string,
  label: string,
  value: number | undefined,
  options: {
    unit?: Metric['unit']
    previous?: number | undefined
    better: 'up' | 'down'
    hint?: string
    tone?: Tone
  },
): Metric {
  if (value === undefined) return { id, label, value: 'n/a', unit: 'text' }
  const { tone, previous, ...rest } = options
  return {
    ...metric(id, label, value, { ...rest, ...(previous === undefined ? {} : { previous }) }),
    ...(tone ? { tone } : {}),
  }
}

const perWeek = (data: CiJobsData) => data.totals.computeSeconds / Math.max(data.window.days / 7, 1)

const mainGroup = (data: CiJobsData | undefined) =>
  data?.refGroups?.find((group) => group.group === 'main')

function headline(data: CiJobsData, previous?: CiJobsData): Metric[] {
  const { totals } = data
  const before = previous?.totals
  const main = mainGroup(data)
  return [
    ...(main
      ? [
          measured('main-branch-time', 'Main branch pipeline (median)', ms(main.duration.median), {
            unit: 'ms',
            previous: ms(mainGroup(previous)?.duration.median),
            better: 'down',
            hint: `${main.pipelines} pipelines on ${main.topRefs.map((r) => r.ref).join(', ')}, passing ones timed. p95 ${formatDuration(main.duration.p95 ?? 0)}.`,
          }),
        ]
      : []),
    measured('wall-time', 'Pipeline time (median)', ms(totals.wallTime.median), {
      unit: 'ms',
      previous: ms(before?.wallTime.median),
      better: 'down',
      hint: `Time any job of the pipeline was running; waits such as a manual job started later are left out. p95 ${formatDuration(totals.wallTime.p95 ?? 0)} over ${totals.wallTime.samples} pipelines.`,
    }),
    measured('failure-rate', 'Job failure rate', totals.failureRate, {
      unit: 'percent',
      previous: before?.failureRate,
      better: 'down',
      tone: failureTone(totals.failureRate),
      hint: `${totals.failures} failed final attempts; jobs allowed to fail and canceled ones left out.`,
    }),
    measured('slower-jobs', 'Jobs slower', totals.slowerJobs, {
      previous: before?.slowerJobs,
      better: 'down',
      tone: totals.slowerJobs > 0 ? 'bad' : 'good',
      hint: `Median of the last ${data.options.recentDays} days against the rest of the window.`,
    }),
    measured('faster-jobs', 'Jobs faster', totals.fasterJobs, {
      previous: before?.fasterJobs,
      better: 'up',
      ...(totals.fasterJobs > 0 ? { tone: 'good' as const } : {}),
    }),
    measured('flaky-jobs', 'Flaky jobs', totals.flakyJobs, {
      previous: before?.flakyJobs,
      better: 'down',
      tone: totals.flakyJobs > 0 ? 'warning' : 'good',
      hint: 'An attempt failed and a retry in the same pipeline passed.',
    }),
    measured('compute-per-week', 'CI time per week', ms(perWeek(data)), {
      unit: 'ms',
      previous: previous ? ms(perWeek(previous)) : undefined,
      better: 'down',
      hint: `Run time of every job attempt; ${totals.runs} attempts in ${totals.pipelines} pipelines.`,
    }),
    measured('queue', 'Queue (median)', ms(totals.queue.median), {
      unit: 'ms',
      previous: ms(before?.queue.median),
      better: 'down',
      hint: `Waiting for a runner. p95 ${formatDuration(totals.queue.p95 ?? 0)}.`,
    }),
  ]
}

function pipelinesSection(data: CiJobsData): Section {
  const weeks = data.weeks.map((w) => ({ ...w, label: weekLabel(w.week) }))
  const blocks: Block[] = [
    {
      type: 'chart',
      title: 'Pipeline time per week',
      chart: 'line',
      unit: 'ms',
      x: 'week',
      series: [
        { key: 'median', label: 'Median', tone: 'info' },
        { key: 'p95', label: 'p95', tone: 'warning', dashed: true },
      ],
      bands: [{ low: 'p25', high: 'p75', label: 'p25–p75', tone: 'info' }],
      data: weeks.map((w) => ({
        week: w.label,
        median: ms(w.median) ?? null,
        p95: ms(w.p95) ?? null,
        p25: ms(w.p25) ?? null,
        p75: ms(w.p75) ?? null,
      })),
    },
    {
      type: 'chart',
      title: 'Job runs and failure rate per week',
      chart: 'combo',
      unit: 'count',
      rightUnit: 'percent',
      x: 'week',
      series: [
        { key: 'runs', label: 'Job runs', tone: 'neutral', as: 'bar' },
        { key: 'failureRate', label: 'Failure rate', tone: 'bad', as: 'line', axis: 'right' },
      ],
      data: weeks.map((w) => ({
        week: w.label,
        runs: w.runs,
        failureRate: w.failureRate ?? null,
      })),
    },
    {
      type: 'chart',
      title: 'CI time and queue per week',
      chart: 'combo',
      unit: 'ms',
      rightUnit: 'ms',
      x: 'week',
      series: [
        { key: 'compute', label: 'CI time', tone: 'info', as: 'area' },
        { key: 'queue', label: 'Queue (median)', tone: 'warning', as: 'line', axis: 'right' },
      ],
      data: weeks.map((w) => ({
        week: w.label,
        compute: ms(w.computeSeconds) ?? 0,
        queue: ms(w.queueMedian) ?? null,
      })),
    },
  ]
  if (data.stages.length > 1)
    blocks.push({
      type: 'chart',
      title: 'CI time by stage',
      chart: 'donut',
      unit: 'ms',
      x: 'stage',
      series: [{ key: 'compute', label: 'CI time' }],
      data: data.stages.map((s) => ({ stage: s.stage, compute: ms(s.computeSeconds) ?? 0 })),
    })
  return {
    id: 'pipelines',
    title: 'Pipelines',
    description: `${data.totals.pipelines} pipelines and ${data.totals.runs} job attempts in the last ${data.window.days} days.`,
    blocks,
  }
}

const GROUP_TONE: Record<RefGroupStats['group'], Tone> = {
  main: 'info',
  develop: 'good',
  release: 'warning',
  feature: 'neutral',
  'merge-request': 'neutral',
  tag: 'bad',
}

function refGroupsSection(data: CiJobsData): Section | undefined {
  const groups = data.refGroups ?? []
  if (!groups.length) return undefined
  const changeTone = (change: number | undefined): Tone =>
    change === undefined
      ? 'neutral'
      : change >= data.options.changePercent
        ? 'bad'
        : change <= -data.options.changePercent
          ? 'good'
          : 'neutral'
  const blocks: Block[] = [
    {
      type: 'table',
      columns: [
        { key: 'group', label: 'Refs' },
        { key: 'pipelines', label: 'Pipelines', align: 'end' },
        { key: 'refs', label: 'Distinct refs', align: 'end' },
        { key: 'median', label: 'Median', unit: 'ms', format: 'sparkline' },
        { key: 'p95', label: 'p95', unit: 'ms', align: 'end' },
        { key: 'change', label: 'Recent change', align: 'end' },
        { key: 'failureRate', label: 'Failed', unit: 'percent', align: 'end' },
      ],
      rows: groups.map((group) => ({
        group: { text: group.label, tone: GROUP_TONE[group.group] },
        pipelines: group.pipelines,
        refs: group.refs,
        median: {
          text: formatDuration(group.duration.median ?? 0),
          value: ms(group.duration.median) ?? 0,
          series: group.weeks.map((w) => ms(w.median) ?? null),
          tone: changeTone(group.change),
        },
        p95: ms(group.duration.p95) ?? null,
        change:
          group.change === undefined
            ? null
            : { text: signed(group.change), value: group.change, tone: changeTone(group.change) },
        failureRate:
          group.failureRate === undefined
            ? null
            : {
                text: `${group.failureRate}%`,
                value: group.failureRate,
                tone: failureTone(group.failureRate),
              },
      })),
    },
    {
      type: 'chart',
      title: 'Median pipeline time per week',
      chart: 'line',
      unit: 'ms',
      x: 'week',
      series: groups.map((group) => ({
        key: group.group,
        label: group.label,
        tone: GROUP_TONE[group.group],
      })),
      data: data.weeks.map((w, index) => ({
        week: weekLabel(w.week),
        ...Object.fromEntries(
          groups.map((group) => [group.group, ms(group.weeks[index]?.median) ?? null]),
        ),
      })),
    },
    {
      type: 'table',
      title: 'Busiest refs',
      columns: [
        { key: 'ref', label: 'Ref', format: 'code' },
        { key: 'group', label: 'Kind' },
        { key: 'pipelines', label: 'Pipelines', align: 'end' },
        { key: 'median', label: 'Median', unit: 'ms', align: 'end' },
      ],
      rows: groups.flatMap((group) =>
        group.topRefs.map((ref) => ({
          ref: ref.ref,
          group: { text: group.label, tone: GROUP_TONE[group.group] },
          pipelines: ref.pipelines,
          median: ms(ref.median) ?? null,
        })),
      ),
    },
  ]
  return {
    id: 'refs',
    title: 'Pipelines by branch',
    description:
      'Pipeline time (while any of its jobs ran) of passing pipelines, grouped by the kind of ref they ran for. Failure rates count every pipeline.',
    blocks,
  }
}

/** Extra seconds per week a slower job costs (negative when it got faster). */
const weeklyImpact = (job: JobStats, days: number) =>
  ((job.recentMedian ?? 0) - (job.baselineMedian ?? 0)) * (job.runs / Math.max(days / 7, 1))

function shiftIssue(job: JobStats, data: CiJobsData): Issue {
  const slower = job.trend === 'slower'
  const point = job.changePoint
  const from = formatDuration(job.baselineMedian ?? 0)
  const to = formatDuration(job.recentMedian ?? 0)
  const since = point
    ? ` Since ${point.at.slice(0, 10)}${point.sha ? ` (commit ${shortSha(point.sha)}${point.ref ? ` on ${point.ref}` : ''})` : ''}: ${formatDuration(point.before)} → ${formatDuration(point.after)}.`
    : ''
  const impact = Math.abs(weeklyImpact(job, data.window.days))
  return {
    id: `${job.trend}:${job.name}`,
    tone: slower ? ((job.change ?? 0) >= 50 ? 'bad' : 'warning') : 'good',
    title: `${job.name} is ${signed(job.change ?? 0).slice(1)} ${slower ? 'slower' : 'faster'}: ${from} → ${to}`,
    detail: `Median of the last ${data.options.recentDays} days against the ${data.window.days - data.options.recentDays} days before.${since} About ${formatDuration(impact)} of CI time per week ${slower ? 'more' : 'less'}; p95 now ${formatDuration(job.duration.p95 ?? 0)}.`,
    ...(point?.href ? { href: point.href } : { href: job.last.href }),
    tags: [job.stage, ...(point?.sha ? [shortSha(point.sha) ?? ''] : [])],
  }
}

function jobChart(job: JobStats): Block {
  const markerWeek = job.changePoint ? weekLabel(weekOf(job.changePoint.at)) : undefined
  return {
    type: 'chart',
    title: `${job.name}: duration per week`,
    chart: 'line',
    unit: 'ms',
    x: 'week',
    series: [
      { key: 'median', label: 'Median', tone: job.trend === 'slower' ? 'bad' : 'good' },
      { key: 'p95', label: 'p95', tone: 'warning', dashed: true },
    ],
    bands: [
      { low: 'p25', high: 'p75', label: 'p25–p75', tone: job.trend === 'slower' ? 'bad' : 'good' },
    ],
    ...(markerWeek
      ? {
          markers: [
            {
              x: markerWeek,
              label: shortSha(job.changePoint?.sha) ?? 'change',
              tone: job.trend === 'slower' ? 'bad' : 'good',
            },
          ],
        }
      : {}),
    data: job.weeks.map((w) => ({
      week: weekLabel(w.week),
      median: ms(w.median) ?? null,
      p95: ms(w.p95) ?? null,
      p25: ms(w.p25) ?? null,
      p75: ms(w.p75) ?? null,
    })),
  }
}

function shiftsSection(data: CiJobsData): Section {
  const impact = (job: JobStats) => Math.abs(weeklyImpact(job, data.window.days))
  const slower = data.jobs
    .filter((j) => j.trend === 'slower')
    .toSorted((a, b) => impact(b) - impact(a))
  const faster = data.jobs
    .filter((j) => j.trend === 'faster')
    .toSorted((a, b) => impact(b) - impact(a))
  const blocks: Block[] = []
  if (!slower.length && !faster.length)
    blocks.push({
      type: 'markdown',
      text: `No job changed its median by ${data.options.changePercent}% and ${formatDuration(data.options.minChangeSeconds)} or more in the last ${data.options.recentDays} days.`,
    })
  if (slower.length)
    blocks.push({
      type: 'issues',
      title: 'Slower',
      items: slower.map((job) => shiftIssue(job, data)),
    })
  blocks.push(...slower.slice(0, CHARTED_SLOWDOWNS).map(jobChart))
  if (faster.length)
    blocks.push({
      type: 'issues',
      title: 'Faster',
      items: faster.map((job) => shiftIssue(job, data)),
    })
  return {
    id: 'shifts',
    title: 'Slowdowns and speedups',
    description: 'Jobs whose recent median moved, ordered by CI time per week they add or save.',
    blocks,
  }
}

function jobsSection(data: CiJobsData): Section {
  const rows = data.jobs.slice(0, TABLE_JOBS).map((job): Record<string, Cell> => ({
    job: {
      text: job.name,
      href: job.last.href,
      ...(job.allowFailure ? { hint: 'Allowed to fail' } : {}),
    },
    stage: job.stage,
    runs: job.runs,
    median: {
      text: formatDuration(job.duration.median ?? 0),
      value: ms(job.duration.median) ?? 0,
      series: job.weeks.map((w) => ms(w.median) ?? null),
      tone: TREND_TONE[job.trend],
    },
    p95: ms(job.duration.p95) ?? null,
    change:
      job.change === undefined
        ? null
        : { text: signed(job.change), value: job.change, tone: TREND_TONE[job.trend] },
    failureRate:
      job.failureRate === undefined
        ? null
        : {
            text: `${job.failureRate}%`,
            value: job.failureRate,
            series: job.weeks.map((w) => w.failureRate ?? null),
            tone: failureTone(job.failureRate),
          },
    retryRate: job.retryRate,
    flaky: job.flaky,
    share: job.computeShare,
  }))
  return {
    id: 'jobs',
    title: 'Jobs',
    description: `Every job by CI time, with weekly median duration and failure rate.${data.jobs.length > TABLE_JOBS ? ` The ${TABLE_JOBS} heaviest of ${data.jobs.length}.` : ''}`,
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'job', label: 'Job', format: 'code' },
          { key: 'stage', label: 'Stage' },
          { key: 'runs', label: 'Runs', align: 'end' },
          { key: 'median', label: 'Median', unit: 'ms', format: 'sparkline' },
          { key: 'p95', label: 'p95', unit: 'ms', align: 'end' },
          { key: 'change', label: 'Recent change', align: 'end' },
          { key: 'failureRate', label: 'Failure rate', unit: 'percent', format: 'sparkline' },
          { key: 'retryRate', label: 'Retried', unit: 'percent', align: 'end' },
          { key: 'flaky', label: 'Flaky', align: 'end' },
          { key: 'share', label: 'CI time share', unit: 'percent', align: 'end' },
        ],
        rows,
      },
    ],
  }
}

function heatmapsSection(data: CiJobsData): Section {
  const jobs = data.jobs.slice(0, HEATMAP_JOBS)
  const columns = data.weeks.map((w) => weekLabel(w.week))
  const durationRows: HeatmapRow[] = jobs.map((job) => {
    const base = job.duration.median
    return {
      label: job.name,
      href: job.last.href,
      cells: job.weeks.map((w) =>
        w.median === undefined || !base
          ? null
          : {
              value: round(((w.median - base) / base) * 100),
              text: `${formatDuration(w.median)} (${signed(round(((w.median - base) / base) * 100, 0))} vs ${formatDuration(base)})`,
            },
      ),
    }
  })
  const failureRows: HeatmapRow[] = jobs
    .filter((job) => (job.failureRate ?? 0) > 0)
    .map((job) => ({
      label: job.name,
      href: job.last.href,
      cells: job.weeks.map((w) =>
        w.failureRate === undefined
          ? null
          : { value: w.failureRate, text: `${w.failureRate}% of ${w.runs} runs` },
      ),
    }))
  const blocks: Block[] = [
    {
      type: 'heatmap',
      title: 'Weekly median against the job’s own median',
      xLabels: columns,
      yRows: durationRows,
      unit: 'percent',
      scale: { kind: 'diverging', better: 'down', limit: 50 },
    },
  ]
  if (failureRows.length)
    blocks.push({
      type: 'heatmap',
      title: 'Failure rate per week',
      xLabels: columns,
      yRows: failureRows,
      unit: 'percent',
      scale: { kind: 'sequential', tone: 'bad' },
    })
  return {
    id: 'heatmaps',
    title: 'Week by week',
    description: `The ${jobs.length} jobs with the most CI time. Red weeks ran slower or failed more.`,
    blocks,
  }
}

function reliabilitySection(data: CiJobsData): Section {
  const unreliable = data.jobs
    .filter((j) => j.failures > 0 || j.flaky > 0)
    .toSorted(
      (a, b) =>
        (b.failureRate ?? 0) - (a.failureRate ?? 0) ||
        b.flaky - a.flaky ||
        a.name.localeCompare(b.name),
    )
  const blocks: Block[] = unreliable.length
    ? [
        {
          type: 'table',
          columns: [
            { key: 'job', label: 'Job', format: 'code' },
            { key: 'stage', label: 'Stage' },
            { key: 'failureRate', label: 'Failure rate', unit: 'percent', align: 'end' },
            { key: 'failures', label: 'Failures', align: 'end' },
            { key: 'flaky', label: 'Flaky pipelines', align: 'end' },
            { key: 'retryRate', label: 'Retried', unit: 'percent', align: 'end' },
            { key: 'last', label: 'Last run' },
          ],
          rows: unreliable.map((job) => ({
            job: { text: job.name, href: job.last.href },
            stage: job.stage,
            failureRate: {
              text: `${job.failureRate ?? 0}%`,
              value: job.failureRate ?? 0,
              tone: failureTone(job.failureRate),
            },
            failures: job.failures,
            flaky:
              job.flaky > 0 ? { text: String(job.flaky), value: job.flaky, tone: 'warning' } : 0,
            retryRate: job.retryRate,
            last: {
              text: job.last.status,
              href: job.last.href,
              tone:
                job.last.status === 'success'
                  ? 'good'
                  : job.last.status === 'failed'
                    ? 'bad'
                    : 'neutral',
            },
          })),
        },
      ]
    : [{ type: 'markdown', text: 'No job failed or needed a retry to pass in the window.' }]
  return {
    id: 'reliability',
    title: 'Reliability',
    description: 'Jobs that failed or passed only on retry, worst failure rate first.',
    blocks,
  }
}

const SYNC_TEXT: Record<CiJobsData['sync']['mode'], string> = {
  full: 'full history read',
  incremental: 'only jobs since the previous run read',
  none: 'nothing read',
}

function notesSection(data: CiJobsData): Section {
  const { history, sync, options } = data
  const lines = [
    `- Window: ${data.window.from.slice(0, 10)} to ${data.window.to.slice(0, 10)} (${data.window.days} days)${options.branch ? `, pipelines on \`${options.branch}\` only` : ', every branch'}.`,
    `- Stored history: ${history.jobs} job attempts${history.oldest && history.newest ? ` from ${history.oldest.slice(0, 10)} to ${history.newest.slice(0, 10)}` : ''}. This run: ${SYNC_TEXT[sync.mode]}${sync.after ? ` after ${sync.after.slice(0, 10)}` : ''}, ${sync.fetched} attempts fetched, ${sync.stored} finished ones stored.`,
    `- Durations are successful attempts; failure rates count final attempts, leaving out jobs allowed to fail and canceled ones.`,
    `- A job is slower or faster when its median over the last ${options.recentDays} days moved by ${options.changePercent}% and ${formatDuration(options.minChangeSeconds)} or more, with at least 5 successful runs on each side. The change date is where daily medians shift most.`,
    `- Pipeline time is how long any job of the pipeline was running, retries included; gaps, such as a manual job started days later, do not count.`,
    ...data.notes.map((note) => `- ${note}`),
  ]
  return { id: 'notes', title: 'Notes', blocks: [{ type: 'markdown', text: lines.join('\n') }] }
}

/** The full CI jobs report, compared with `previous` when given. */
export function ciJobsReport(
  data: CiJobsData,
  options: { previous?: CiJobsData; repo?: RepoRef; ref?: string; generatedAt?: string } = {},
): Report {
  const refsSection = refGroupsSection(data)
  return {
    kind: 'ci-jobs',
    title: 'CI jobs',
    subtitle: `Last ${data.window.days} days${data.options.branch ? ` on ${data.options.branch}` : ''}`,
    subject: {
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.ref ? { ref: options.ref } : {}),
    },
    generatedAt: options.generatedAt ?? data.window.to,
    metrics: headline(data, options.previous),
    sections: [
      shiftsSection(data),
      pipelinesSection(data),
      ...(refsSection ? [refsSection] : []),
      jobsSection(data),
      heatmapsSection(data),
      reliabilitySection(data),
      notesSection(data),
    ],
  }
}

/** The `ci-jobs` analysis kind: job durations, slowdowns and failure rates of a repository. */
export const ciJobsAnalysis = defineAnalysis<CiJobsData>({
  kind: 'ci-jobs',
  label: 'CI jobs',
  schema: ciJobsDataSchema,
  summarize: (data) => headline(data),
  toReport: (current, previous) =>
    ciJobsReport(current.data, {
      ...(previous ? { previous: previous.data } : {}),
      repo: current.repo,
      ...(current.ref ? { ref: current.ref } : {}),
      generatedAt: current.createdAt,
    }),
})
