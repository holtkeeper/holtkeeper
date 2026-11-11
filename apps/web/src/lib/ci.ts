import type { CiJobStats, CiJobsData, CiProblemKind, CiRepoCard } from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { formatDuration } from './format.ts'

/** `3 min 5 s` from seconds; `—` when unknown. */
export const seconds = (value: number | undefined | null): string =>
  value === undefined || value === null ? '—' : formatDuration(value * 1000)

/** Tone of a failure rate: under 5% fine, under 15% a warning, above that bad. */
export const failureTone = (rate: number | undefined): StatusTone =>
  rate === undefined || rate < 5 ? 'success' : rate < 15 ? 'warning' : 'danger'

/** Tone of a success rate, the mirror of `failureTone`. */
export const successTone = (rate: number | undefined): StatusTone =>
  rate === undefined ? 'default' : failureTone(100 - rate)

export const problemTones: Record<CiProblemKind, StatusTone> = {
  failing: 'danger',
  slower: 'warning',
  flaky: 'warning',
}

/**
 * A pipeline time change as an arrow and percent: `↑ 12%` is slower and reads as bad, `↓ 8%`
 * faster and good; changes under 5% stay neutral.
 */
export function changeLabel(change: number | undefined): { text: string; tone: StatusTone } {
  if (change === undefined) return { text: '', tone: 'default' }
  const rounded = Math.round(change)
  if (rounded === 0) return { text: '± 0%', tone: 'default' }
  const tone = Math.abs(change) < 5 ? 'default' : change > 0 ? 'danger' : 'success'
  return { text: `${rounded > 0 ? '↑' : '↓'} ${Math.abs(rounded)}%`, tone }
}

/** One job box of the pipeline picture. */
export interface PipelineBox {
  name: string
  median?: number
  failureRate?: number
  tone: StatusTone
  allowFailure: boolean
  flags: CiProblemKind[]
  href: string
}

/** Jobs grouped by stage in run order, each box coloured by its failure rate. */
export function stageColumns(
  data: Pick<CiJobsData, 'stages' | 'jobs'>,
  flags: Readonly<Record<string, readonly CiProblemKind[]>>,
): { stage: string; jobs: PipelineBox[] }[] {
  const byStage = new Map<string, CiJobStats[]>()
  for (const job of data.jobs) byStage.set(job.stage, [...(byStage.get(job.stage) ?? []), job])
  const order = [...data.stages, ...[...byStage.keys()].filter((s) => !data.stages.includes(s))]
  return order.flatMap((stage) => {
    const jobs = byStage.get(stage)
    if (!jobs?.length) return []
    return [
      {
        stage,
        jobs: jobs.map((job) => ({
          name: job.name,
          ...(job.duration.median === undefined ? {} : { median: job.duration.median }),
          ...(job.failureRate === undefined ? {} : { failureRate: job.failureRate }),
          tone: job.allowFailure ? 'default' : failureTone(job.failureRate),
          allowFailure: job.allowFailure,
          flags: [...(flags[job.name] ?? [])],
          href: job.last.href,
        })),
      },
    ]
  })
}

/** Jobs that failed or passed only on retry, worst failure rate first. */
export const unreliableJobs = (jobs: readonly CiJobStats[]): CiJobStats[] =>
  jobs
    .filter((job) => job.failures > 0 || job.flaky > 0)
    .toSorted(
      (a, b) =>
        (b.failureRate ?? 0) - (a.failureRate ?? 0) ||
        b.flaky - a.flaky ||
        a.name.localeCompare(b.name),
    )

/** Overview order: repositories with problem jobs first, then by path. */
export const sortCiCards = <T extends Pick<CiRepoCard, 'repo' | 'problems'>>(
  cards: readonly T[],
): T[] =>
  cards.toSorted(
    (a, b) =>
      Number(b.problems > 0) - Number(a.problems > 0) ||
      `${a.repo.forge}:${a.repo.path}`.localeCompare(`${b.repo.forge}:${b.repo.path}`),
  )
