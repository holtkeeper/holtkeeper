import type { RepoRef } from '@holtkeeper/forge'
import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Block, Cell, Metric, Report, Section, Tone } from '@holtkeeper/report'

import { deliveryDataSchema } from './analyze.ts'
import { bandTone } from './dora.ts'
import type { Band, DeliveryData, Distribution } from './types.ts'

const ms = (seconds: number | undefined) =>
  seconds === undefined ? undefined : Math.round(seconds * 1000)

const BAND_LABEL: Record<Band, string> = {
  elite: 'Elite',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

function measured(
  id: string,
  label: string,
  value: number | undefined,
  options: {
    unit?: Metric['unit']
    previous?: number
    better?: 'up' | 'down'
    hint?: string
    tone?: Tone
  },
): Metric {
  if (value === undefined)
    return {
      id,
      label,
      value: 'n/a',
      unit: 'text',
      ...(options.hint ? { hint: options.hint } : {}),
    }
  const { tone, ...rest } = options
  return { ...metric(id, label, value, rest), ...(tone ? { tone } : {}) }
}

const withBand = (band: Band | undefined, hint: string) => ({
  hint: band ? `${hint} DORA band: ${BAND_LABEL[band]}.` : hint,
  ...(band ? { tone: bandTone[band] } : {}),
})

function doraMetrics(data: DeliveryData, previous?: DeliveryData): Metric[] {
  const { dora } = data
  const before = previous?.dora
  return [
    measured('deployment-frequency', 'Deployments per week', dora.deploymentsPerWeek, {
      previous: before?.deploymentsPerWeek,
      better: 'up',
      ...withBand(dora.bands.deploymentFrequency, `${dora.deployments} releases (${dora.source}).`),
    }),
    measured('lead-time', 'Lead time for changes', ms(dora.leadTime.median), {
      unit: 'ms',
      previous: ms(before?.leadTime.median),
      better: 'down',
      ...withBand(dora.bands.leadTime, 'Median, merge request created → deployed.'),
    }),
    measured('change-failure-rate', 'Change failure rate', dora.changeFailureRate, {
      unit: 'percent',
      previous: before?.changeFailureRate,
      better: 'down',
      ...withBand(dora.bands.changeFailureRate, `${dora.failedChanges} failed changes.`),
    }),
    measured('time-to-restore', 'Time to restore', ms(dora.timeToRestore.median), {
      unit: 'ms',
      previous: ms(before?.timeToRestore.median),
      better: 'down',
      ...withBand(
        dora.bands.timeToRestore,
        `Median over ${dora.timeToRestore.incidents} incidents.`,
      ),
    }),
  ]
}

function headline(data: DeliveryData, previous?: DeliveryData): Metric[] {
  const { ci, mergeRequests } = data
  return [
    ...doraMetrics(data, previous),
    measured('pipeline-success', 'Pipeline success rate', ci.successRate, {
      unit: 'percent',
      previous: previous?.ci.successRate,
      better: 'up',
    }),
    measured('pipeline-duration', 'Pipeline duration (median)', ms(ci.duration.median), {
      unit: 'ms',
      previous: ms(previous?.ci.duration.median),
      better: 'down',
    }),
    measured('flaky-jobs', 'Flaky jobs', ci.flakyJobs.length, {
      previous: previous?.ci.flakyJobs.length,
      better: 'down',
      tone: ci.flakyJobs.length > 0 ? 'warning' : 'good',
    }),
    measured('stale-merge-requests', 'Stale merge requests', mergeRequests.stale.length, {
      previous: previous?.mergeRequests.stale.length,
      better: 'down',
      tone: mergeRequests.stale.length > 0 ? 'warning' : 'good',
    }),
  ]
}

const bandCell = (band: Band | undefined): Cell =>
  band ? { text: BAND_LABEL[band], tone: bandTone[band] } : 'n/a'

function doraSection(data: DeliveryData, previous?: DeliveryData): Section {
  const { dora } = data
  const blocks: Block[] = [
    { type: 'metrics', metrics: doraMetrics(data, previous) },
    {
      type: 'table',
      title: 'Performance bands',
      columns: [
        { key: 'metric', label: 'Metric' },
        { key: 'band', label: 'Band' },
        { key: 'detail', label: 'Detail' },
      ],
      rows: [
        {
          metric: 'Deployment frequency',
          band: bandCell(dora.bands.deploymentFrequency),
          detail: `${dora.deployments} successful, ${dora.failedDeployments} failed`,
        },
        {
          metric: 'Lead time for changes',
          band: bandCell(dora.bands.leadTime),
          detail: `${dora.leadTime.samples} changes, ${dora.undeployed} merged but not deployed yet`,
        },
        {
          metric: 'Change failure rate',
          band: bandCell(dora.bands.changeFailureRate),
          detail: `${dora.failedChanges} of ${dora.deployments} deployments`,
        },
        {
          metric: 'Time to restore',
          band: bandCell(dora.bands.timeToRestore),
          detail: `${dora.timeToRestore.incidents} incidents, ${dora.timeToRestore.unresolved} unresolved`,
        },
      ],
    },
    {
      type: 'chart',
      title: 'Deployments per week',
      chart: 'stacked-bar',
      unit: 'count',
      x: 'week',
      series: [
        { key: 'ok', label: 'Successful changes', tone: 'good' },
        { key: 'failed', label: 'Failed changes', tone: 'bad' },
      ],
      data: dora.weeks.map((w) => ({
        week: w.week,
        ok: w.deployments - w.failedChanges,
        failed: w.failedChanges,
      })),
    },
    {
      type: 'chart',
      title: 'Lead time per week (median)',
      chart: 'line',
      unit: 'ms',
      x: 'week',
      series: [{ key: 'leadTime', label: 'Lead time', tone: 'info' }],
      data: dora.weeks.map((w) => ({
        week: w.week,
        ...(w.leadTimeMedian === undefined
          ? {}
          : { leadTime: Math.round(w.leadTimeMedian * 1000) }),
      })),
    },
    {
      type: 'table',
      title: 'Lead time breakdown',
      columns: [
        { key: 'stage', label: 'Stage' },
        { key: 'median', label: 'Median', unit: 'ms', align: 'end' },
        { key: 'p90', label: 'p90', unit: 'ms', align: 'end' },
        { key: 'samples', label: 'Changes', align: 'end' },
      ],
      rows: (
        [
          ['Created → deployed', dora.leadTime],
          ['Created → merged', dora.timeToMerge],
          ['Merged → deployed', dora.timeToDeploy],
        ] as const satisfies readonly (readonly [string, Distribution])[]
      ).map(([stage, d]) => ({
        stage,
        median: ms(d.median) ?? null,
        p90: ms(d.p90) ?? null,
        samples: d.samples,
      })),
    },
  ]
  if (dora.failures.length > 0)
    blocks.push({
      type: 'issues',
      title: 'Failures',
      items: dora.failures.map((f, i) => ({
        id: `failure-${i}`,
        tone: f.restoreSeconds === undefined ? 'bad' : 'warning',
        title: f.title,
        detail: [
          `${f.kind} at ${f.at}`,
          f.blamedOn
            ? `blamed on ${f.blamedOn}`
            : 'no deployment within the failure window before it',
          f.restoreSeconds === undefined
            ? 'not restored yet'
            : `restored after ${Math.round(f.restoreSeconds / 60)} min`,
        ].join(' · '),
        ...(f.href ? { href: f.href } : {}),
        tags: [f.kind],
      })),
    })
  return { id: 'dora', title: 'DORA', description: `Releases from ${dora.source}.`, blocks }
}

const statusCell = (isNew: boolean): Cell => (isNew ? { text: 'new', tone: 'warning' } : '')

function pipelinesSection(data: DeliveryData, previous?: DeliveryData): Section {
  const { ci } = data
  const before = previous?.ci
  const previousFlaky = new Set(before?.flakyJobs.map((j) => j.name))
  const previousFailing = new Set(before?.failingJobs.map((j) => j.name))
  const blocks: Block[] = [
    {
      type: 'metrics',
      metrics: [
        metric('pipelines', 'Pipelines', ci.pipelines, { previous: before?.pipelines }),
        measured('success-rate', 'Success rate', ci.successRate, {
          unit: 'percent',
          previous: before?.successRate,
          better: 'up',
        }),
        measured('duration-median', 'Duration (median)', ms(ci.duration.median), {
          unit: 'ms',
          previous: ms(before?.duration.median),
          better: 'down',
        }),
        measured('duration-p95', 'Duration (p95)', ms(ci.duration.p95), {
          unit: 'ms',
          previous: ms(before?.duration.p95),
          better: 'down',
        }),
        measured('queue-median', 'Queue time (median)', ms(ci.queue.median), {
          unit: 'ms',
          previous: ms(before?.queue.median),
          better: 'down',
        }),
      ],
    },
    {
      type: 'chart',
      title: 'Pipeline duration per week',
      chart: 'line',
      unit: 'ms',
      x: 'week',
      series: [
        { key: 'median', label: 'Median', tone: 'info' },
        { key: 'p95', label: 'p95', tone: 'warning' },
        { key: 'queue', label: 'Queue (median)', tone: 'neutral' },
      ],
      data: ci.weeks.map((w) => ({
        week: w.week,
        ...(w.durationMedian === undefined ? {} : { median: Math.round(w.durationMedian * 1000) }),
        ...(w.durationP95 === undefined ? {} : { p95: Math.round(w.durationP95 * 1000) }),
        ...(w.queueMedian === undefined ? {} : { queue: Math.round(w.queueMedian * 1000) }),
      })),
    },
    {
      type: 'chart',
      title: 'Pipeline success rate per week',
      chart: 'area',
      unit: 'percent',
      x: 'week',
      series: [{ key: 'successRate', label: 'Success rate', tone: 'good' }],
      data: ci.weeks.map((w) => ({
        week: w.week,
        ...(w.successRate === undefined ? {} : { successRate: w.successRate }),
      })),
    },
    {
      type: 'table',
      title: 'Slowest jobs',
      columns: [
        { key: 'name', label: 'Job', format: 'code' },
        { key: 'stage', label: 'Stage' },
        { key: 'median', label: 'Median', unit: 'ms', align: 'end' },
        { key: 'p95', label: 'p95', unit: 'ms', align: 'end' },
        { key: 'runs', label: 'Runs', align: 'end' },
      ],
      rows: ci.slowestJobs.map((j) => ({
        name: j.name,
        stage: j.stage,
        median: Math.round(j.median * 1000),
        p95: Math.round(j.p95 * 1000),
        runs: j.runs,
      })),
    },
    {
      type: 'table',
      title: 'Flaky jobs',
      columns: [
        { key: 'name', label: 'Job', format: 'code' },
        { key: 'stage', label: 'Stage' },
        { key: 'retried', label: 'Passed on retry', align: 'end' },
        { key: 'alternating', label: 'Mixed results per commit', align: 'end' },
        { key: 'status', label: '' },
      ],
      rows: ci.flakyJobs.map((j) => ({
        name: j.name,
        stage: j.stage,
        retried: j.retriedThenPassed,
        alternating: j.alternatingShas,
        status: statusCell(previous !== undefined && !previousFlaky.has(j.name)),
      })),
    },
    {
      type: 'table',
      title: 'Most failing jobs',
      columns: [
        { key: 'name', label: 'Job', format: 'code' },
        { key: 'stage', label: 'Stage' },
        { key: 'failures', label: 'Failures', align: 'end' },
        { key: 'rate', label: 'Failure rate', unit: 'percent', align: 'end' },
        { key: 'status', label: '' },
      ],
      rows: ci.failingJobs.map((j) => ({
        name: j.name,
        stage: j.stage,
        failures: j.failures,
        rate: j.failureRate,
        status: statusCell(previous !== undefined && !previousFailing.has(j.name)),
      })),
    },
  ]
  const fixed =
    before?.flakyJobs.filter((j) => !ci.flakyJobs.some((now) => now.name === j.name)) ?? []
  if (fixed.length > 0)
    blocks.push({
      type: 'markdown',
      text: `No longer flaky: ${fixed.map((j) => `\`${j.name}\``).join(', ')}.`,
    })
  return {
    id: 'pipelines',
    title: 'Pipelines',
    description: `Jobs of the newest ${ci.jobPipelines} finished pipelines.`,
    blocks,
  }
}

function mergeRequestsSection(data: DeliveryData, previous?: DeliveryData): Section {
  const flow = data.mergeRequests
  const before = previous?.mergeRequests
  const previousStale = new Set(before?.stale.map((mr) => mr.id))
  const blocks: Block[] = [
    {
      type: 'metrics',
      metrics: [
        metric('open', 'Open', flow.open, { previous: before?.open, better: 'down' }),
        metric('drafts', 'Drafts', flow.drafts, { previous: before?.drafts }),
        metric('stale', 'Stale', flow.stale.length, {
          previous: before?.stale.length,
          better: 'down',
          hint: `No update for ${data.options.staleDays} days.`,
        }),
        metric('merged', 'Merged', flow.merged, { previous: before?.merged, better: 'up' }),
        measured('time-to-merge', 'Time to merge (median)', ms(flow.timeToMerge.median), {
          unit: 'ms',
          previous: ms(before?.timeToMerge.median),
          better: 'down',
        }),
        measured('time-to-merge-p90', 'Time to merge (p90)', ms(flow.timeToMerge.p90), {
          unit: 'ms',
          previous: ms(before?.timeToMerge.p90),
          better: 'down',
        }),
        ...(flow.size?.median === undefined
          ? []
          : [
              metric('size', 'Changed files (median)', flow.size.median, {
                previous: before?.size?.median,
                better: 'down',
              }),
            ]),
      ],
    },
    {
      type: 'chart',
      title: 'Open merge requests by age',
      chart: 'bar',
      unit: 'count',
      x: 'age',
      series: [{ key: 'count', label: 'Open', tone: 'info' }],
      data: flow.openByAge.map((b) => ({ age: b.label, count: b.count })),
    },
    {
      type: 'chart',
      title: 'Time to merge',
      chart: 'bar',
      unit: 'count',
      x: 'duration',
      series: [{ key: 'count', label: 'Merged', tone: 'neutral' }],
      data: flow.timeToMerge.buckets.map((b) => ({ duration: b.label, count: b.count })),
    },
    {
      type: 'table',
      title: 'Stale merge requests',
      columns: [
        { key: 'title', label: 'Merge request' },
        { key: 'author', label: 'Author' },
        { key: 'updated', label: 'Last update', format: 'date' },
        { key: 'idle', label: 'Idle days', align: 'end' },
        { key: 'age', label: 'Age days', align: 'end' },
        { key: 'labels', label: 'Labels', format: 'tags' },
        { key: 'status', label: '' },
      ],
      rows: flow.stale.map((mr) => ({
        title: {
          text: `!${mr.id} ${mr.title}`,
          href: mr.webUrl,
          ...(mr.draft ? { hint: 'Draft' } : {}),
        },
        author: mr.author,
        updated: mr.updatedAt,
        idle: mr.idleDays,
        age: mr.ageDays,
        labels: [...(mr.draft ? ['draft'] : []), ...mr.labels].join(','),
        status: statusCell(previous !== undefined && !previousStale.has(mr.id)),
      })),
    },
  ]
  const resolved = before?.stale.filter((mr) => !flow.stale.some((now) => now.id === mr.id)) ?? []
  if (resolved.length > 0)
    blocks.push({
      type: 'markdown',
      text: `No longer stale (merged, closed or updated): ${resolved.map((mr) => `!${mr.id}`).join(', ')}.`,
    })
  return { id: 'merge-requests', title: 'Merge requests', blocks }
}

const SOURCE_TEXT: Record<DeliveryData['dora']['source'], string> = {
  deployments: 'deployments to the production environment',
  tags: 'tags (fallback: no deployments in the window)',
  pipelines: 'successful default-branch pipelines (fallback: no deployments or tags)',
  none: 'nothing (no deployments, tags or default-branch pipelines)',
}

function notesSection(data: DeliveryData): Section {
  const { counts, options } = data
  const lines = [
    `- Window: ${data.window.from.slice(0, 10)} to ${data.window.to.slice(0, 10)} (${data.window.days} days).`,
    `- Releases come from ${SOURCE_TEXT[data.dora.source]}; environment \`${options.productionEnvironment}\`.`,
    `- Fetched: ${counts.mergeRequests} merge requests, ${counts.deployments} deployments, ${counts.tags} tags, ${counts.pipelines} pipelines, ${counts.jobs} job attempts.`,
    `- Lead time pairs each merged merge request with the first successful release after its merge; it does not check that the release contains the commit.`,
    `- A change failed when a failed deployment, a revert or rollback merge request, or a hotfix merge request appears within ${options.failureWindowHours} hours after a release.`,
    `- Pipeline success rate counts succeeded and failed pipelines; canceled, skipped and manual ones are left out.`,
    ...data.notes.map((note) => `- ${note}`),
  ]
  return { id: 'notes', title: 'Notes', blocks: [{ type: 'markdown', text: lines.join('\n') }] }
}

/** The full delivery report, compared with `previous` when given. */
export function deliveryReport(
  data: DeliveryData,
  options: { previous?: DeliveryData; repo?: RepoRef; ref?: string; generatedAt?: string } = {},
): Report {
  const { previous } = options
  return {
    kind: 'delivery',
    title: 'Delivery',
    subtitle: `Last ${data.window.days} days`,
    subject: {
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.ref ? { ref: options.ref } : {}),
    },
    generatedAt: options.generatedAt ?? data.window.to,
    metrics: headline(data, previous),
    sections: [
      doraSection(data, previous),
      pipelinesSection(data, previous),
      mergeRequestsSection(data, previous),
      notesSection(data),
    ],
  }
}

/** The `delivery` analysis kind: DORA metrics, CI health and merge request flow of a repository. */
export const deliveryAnalysis = defineAnalysis<DeliveryData>({
  kind: 'delivery',
  label: 'Delivery',
  schema: deliveryDataSchema,
  summarize: (data) => headline(data),
  toReport: (current, previous) =>
    deliveryReport(current.data, {
      ...(previous ? { previous: previous.data } : {}),
      repo: current.repo,
      ...(current.ref ? { ref: current.ref } : {}),
      generatedAt: current.createdAt,
    }),
})
